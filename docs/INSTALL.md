# Install Manual

> Step-by-step setup, terminal-only validation, a controlled test fire, and a battle-tested troubleshooting section.

## Prerequisites

- **Docker** and **Docker Compose** on the host.
- For AWS metrics: an **IAM role** on the instance with the policy in [`iam-policy.json`](iam-policy.json). Prefer a role over access keys.
- Destination webhooks: a **chat** incoming webhook, and optionally an **on-call** provider webhook.

> ⚠️ **Security first.** Never hardcode secrets in tracked files. Everything goes in `.env` (git-ignored). If a key ever lands in git history, **rotate it** — leaked keys get auto-revoked, but attackers scan fast. See [SECURITY.md](../SECURITY.md).

## Install order

Configure sources before pointing the watcher at them, and validate each layer before moving on.

```
1. IAM        →  2. YACE        →  3. Prometheus  →  4. Rules       →  5. Alertmanager  →  6. relay
   (perms)        (AWS source)      (point at         (alerts.d/)       (routing)           (chat + AI)
                                     sources)
```

### Step 0 — Clone and configure

```bash
git clone https://github.com/YOUR_USERNAME/sentinel-stack.git
cd sentinel-stack
cp .env.example .env     # fill in webhooks / tokens / region
```

### Step 1 — IAM (only for AWS)

Attach the policy in [`iam-policy.json`](iam-policy.json) to your instance role. It's generic — works for SQS, EC2, RDS, any namespace. No change needed when adding services.

### Step 2 — YACE (AWS source)

Edit `config/yace-config.yml`: set your `sts-region` and `regions`, and the metrics you want. SQS is enabled by default; EC2/RDS examples are commented. Then:

```bash
docker compose up -d yace
docker logs yace --tail 20
curl -s localhost:5000/metrics | grep aws_sqs | head
```

You should see one line per resource. **Note the real label** identifying each (here `dimension_QueueName`, not `queue_name`).

> **Correct image:** `quay.io/prometheuscommunity/yet-another-cloudwatch-exporter` (one word: "prometheuscommunity"). The `ghcr.io/prometheus-community/...` path returns *denied*.

### Step 3 — Prometheus

Edit `config/prometheus.yml`: set your app target and the `<PLACEHOLDERS>`. The YACE job and `rule_files: alerts.d/*.yml` are already wired. Reload:

```bash
docker compose up -d prometheus
curl -X POST localhost:9090/-/reload
```

### Step 4 — Rules

Rules live in `config/alerts.d/` (one file per domain). Use the **real label** from step 2. Validate and reload:

```bash
docker run --rm -v "$PWD/config/alerts.d:/r" prom/prometheus:v3.1.0 promtool check rules /r/*.yml
curl -X POST localhost:9090/-/reload
```

### Step 5 — Alertmanager

Edit `config/alertmanager.yml` if needed (severity routing is preconfigured). `ONCALL_WEBHOOK_URL` comes from `.env`.

```bash
docker compose up -d alertmanager
```

### Step 6 — relay

Configured entirely via `.env` (`CHAT_WEBHOOK_URL`, `OPENAI_*`, `GITHUB_*`, the `ENABLE_*` flags). Bring it up:

```bash
docker compose up -d relay
docker logs relay --tail 20
```

## Validation from the terminal (no browser)

Prometheus and Alertmanager have HTTP APIs. Pipe through `python3` (always present) for readable output.

**Targets up?**
```bash
curl -s localhost:9090/api/v1/targets | python3 -c "import sys,json; [print(t['labels'].get('job'),'->',t['health']) for t in json.load(sys.stdin)['data']['activeTargets']]"
```

**Does the metric exist for your filter?**
```bash
curl -s 'localhost:9090/api/v1/query' --data-urlencode 'query=aws_sqs_approximate_number_of_messages_visible_average' | python3 -c "import sys,json; [print(r['metric'].get('dimension_QueueName','?')) for r in json.load(sys.stdin)['data']['result']]"
```

**Which rules are loaded, and their state?**
```bash
curl -s localhost:9090/api/v1/rules | python3 -c "import sys,json; [print(r['name'],'->',r.get('state','?')) for g in json.load(sys.stdin)['data']['groups'] for r in g['rules']]"
```

**Any active alerts?**
```bash
curl -s localhost:9090/api/v1/alerts | python3 -c "import sys,json; d=json.load(sys.stdin)['data']['alerts']; print('none' if not d else '\n'.join(a['labels']['alertname']+' -> '+a['state'] for a in d))"
```

Or just run the bundled smoke test:
```bash
./scripts/smoke-test.sh
```

## Controlled test fire

A healthy system won't fire on its own. Force a **real** fire with a temporary rule that uses a real metric but an always-true threshold (`>= 0`). Copy [`examples/test-alert.yml`](../examples/test-alert.yml) into `config/alerts.d/`, then:

```bash
docker restart prometheus     # see Troubleshooting A for why restart, not reload
```

Wait ~30s, confirm `firing` via the alerts API, and watch chat. **Then remove the test rule** and `docker restart prometheus` again (a `>= 0` rule fires forever).

> A `>= 0` rule only fires if the metric **exists**. If nothing shows (not even pending), the metric isn't arriving — check the YACE target first (Troubleshooting C/D).

---

## Troubleshooting

Every entry below was hit in a real deployment.

### A. Edited the file but Prometheus doesn't see the change (bind-mount inode trap)

**Symptom:** the file on the host has N rules, but `docker exec prometheus grep -c "alert:" /etc/prometheus/alerts.d/<file>` shows a different number. Reload doesn't apply.

**Cause:** the Docker bind-mount points at the file's *inode* at container start. Tools that **recreate** the file (`sed -i`, regenerating it) swap the inode; the container keeps seeing the old one.

**Diagnose:**
```bash
docker exec prometheus md5sum /etc/prometheus/alerts.d/<file>; md5sum config/alerts.d/<file>
```
Different hashes confirm it.

**Fix:** `docker restart prometheus` — it re-reads on start and realigns the inode. Simpler than `--force-recreate` and, since it doesn't recreate the container, doesn't disturb other services' networking.

### B. promtool reports a rule count that doesn't match the file

Almost always case A — `promtool` is reading the file **inside the container**, which diverged from the host. Compare with `docker exec prometheus grep -E "alert:|name:" ...`. Fix: `docker restart prometheus`.

### C. The `cloudwatch` target shows DOWN

```bash
curl -s localhost:9090/api/v1/targets | python3 -c "import sys,json; [print(t['labels'].get('job'),'->',t['health'],'|',t.get('lastError','')) for t in json.load(sys.stdin)['data']['activeTargets']]"
```
- `no such host` → networking/DNS (see D).
- `connection refused` → YACE isn't answering on its port; check `docker ps` and `docker logs yace`.

### D. `lookup yace ... no such host` (different Docker networks)

**Symptom:** Prometheus can't resolve `yace` even though it's `Up`.

**Cause:** YACE and Prometheus are on different Docker networks. Containers resolve each other by name only when they share a network. Common when YACE was started by a separate compose file or without declaring the network — landing on `default` while the rest is on the project network.

**Diagnose:**
```bash
docker inspect prometheus --format '{{range $n,$v := .NetworkSettings.Networks}}{{$n}} {{end}}'
docker inspect yace       --format '{{range $n,$v := .NetworkSettings.Networks}}{{$n}} {{end}}'
```

**Quick (temporary) fix:**
```bash
docker network connect --alias yace <project>_sentinel yace
```
**Permanent fix:** declare the shared network on the `yace` service in `docker-compose.yml` (already done in this repo) and recreate: `docker compose up -d yace`.

> ⚠️ The real network name carries the **project prefix** (the folder name): `sentinel` in compose becomes `<folder>_sentinel` in Docker. Use the prefixed name in `docker network` commands.

### E. `--force-recreate` of one service breaks another's networking

Recreating an isolated service can desync the network's internal DNS, dropping another service's target to `down`. Prefer `docker restart <service>` when you just need to re-read a file (case A) — it doesn't recreate the container or touch networking.

### F. The alert never fires (wrong label)

The filter uses a label that doesn't exist in this YACE build. The real one is `dimension_QueueName`, not `queue_name`. Confirm with the "which resources does Prometheus see" query above and fix all rule filters.

### G. `iam:ListAccountAliases AccessDenied` warning in YACE logs

**Cosmetic.** YACE works fine without it. To silence, add `iam:ListAccountAliases` to the policy; or ignore.

### H. AI triage fails ("AI triage unavailable")

The alert still reaches chat (fail-open) — that's expected, not a pipeline failure. Likely causes: the OpenAI key was revoked (common if it was ever exposed) — rotate it; or the timeout is too short — raise `OPENAI_TIMEOUT_MS`.

## Quick command reference

```bash
docker compose up -d              # bring up everything
docker restart prometheus         # re-read mounted files (fixes inode trap)
curl -X POST localhost:9090/-/reload
docker run --rm -v "$PWD/config/alerts.d:/r" prom/prometheus:v3.1.0 promtool check rules /r/*.yml
./scripts/smoke-test.sh
```

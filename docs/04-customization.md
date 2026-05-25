# Customization

> Quick reference for what to edit per file when adapting Sentinel Stack to your service. Placeholders look like `<THIS>`.

> ⚠️ Credentials never go in these files — they live in `.env`. If one was ever exposed, rotate it.

## `docker-compose.yml`

| Customize | Default | Change to |
|-----------|---------|-----------|
| YACE image version | `...:v0.62.1` | keep, or pin another stable tag |
| Shared network | `sentinel` | keep — but note Docker prefixes it with the folder name |
| relay env flags | `ENABLE_AI_TRIAGE`, `ENABLE_GITHUB_ISSUES` | toggle features on/off |
| Remove YACE | present | delete the service if you don't use AWS |

> **Pitfall #1:** the network must be declared on the service **and** at the compose root. Otherwise YACE lands on `default` and Prometheus can't find it. Docker prefixes the name with the project (folder): `sentinel` → `<folder>_sentinel`.

## `config/yace-config.yml`

| Customize | Default | Change to |
|-----------|---------|-----------|
| `sts-region` / `regions` | `us-east-1` | `<YOUR_REGION>` |
| Job `type` | `AWS/SQS` | add `AWS/EC2`, `AWS/RDS`, … per service |
| Metrics | SQS set | the metrics relevant to your service |
| `searchTags` | commented | enable only to cut noise at scale |

Add a new AWS service by adding a job block — no IAM change needed.

## `config/prometheus.yml`

| Customize | Default | Change to |
|-----------|---------|-----------|
| App target | `<APP_HOST>:<APP_PORT>` | your app's host:port |
| `metrics_path` | `/metrics` | `/actuator/prometheus` for Spring |
| Common labels | `<SERVICE_NAME>`, `<ENVIRONMENT>` | your service / env |
| YACE scrape interval | `60s` | keep (CloudWatch is per-minute) |

## `config/alerts.d/*.yml`

| Customize | Default | Change to |
|-----------|---------|-----------|
| Queue label | `dimension_QueueName` | **confirm the real name** in your YACE `/metrics` |
| Resource filter | (none / regex) | `<YOUR_REGEX>` for the resource you care about |
| Thresholds | `> 100`, `> 500`, `> 300`, `> 900` | tune to your service |
| `for` (persistence) | `5m`, `3m`, `10m` | tune to your tolerance |
| `job=` in expressions | `app`, `cloudwatch` | match your `prometheus.yml` job names |
| Business metrics | `app_*` examples | the metrics your app actually exposes |

> **Pitfall #2:** filter by the resource's real identifier (often embedded in the queue name), not a friendly nickname.
>
> **Pitfall #3:** the YACE metric name is the CloudWatch name + lowercase statistic suffix: `ApproximateNumberOfMessagesVisible` (Average) → `aws_sqs_approximate_number_of_messages_visible_average`.

## `config/alertmanager.yml`

| Customize | Default | Change to |
|-----------|---------|-----------|
| On-call webhook | `${ONCALL_WEBHOOK_URL}` | your pager (or drop the route) |
| relay webhook | `http://relay:3000/alert` | keep (container name) |
| `group_by` | `[alertname, service]` | how you want grouping |
| `repeat_interval` | `1h` | re-notify cadence |
| Severity routes | critical → on-call+chat | add/adjust matchers |

## `relay/relay.js` (via `.env`)

| Customize | Env var | Notes |
|-----------|---------|-------|
| AI on/off | `ENABLE_AI_TRIAGE` | run as a plain chat forwarder if `false` |
| Model | `OPENAI_MODEL` | e.g. `gpt-4o-mini` |
| Timeout | `OPENAI_TIMEOUT_MS` | raise if triage times out |
| Issues on/off | `ENABLE_GITHUB_ISSUES` | off by default |
| Repo | `GITHUB_REPO` | `owner/repo` for auto-filed issues |
| Chat | `CHAT_WEBHOOK_URL` | your chat platform's incoming webhook |

> **On automatic issues:** the **AI** decides (`create_issue`), and creation is automatic. If it gets noisy (duplicates/false positives), make the prompt more conservative, add dedup, or require `severity=critical` in code before filing. To show the queue name in chat, the relay reads standard labels — add `dimension_QueueName` to the message format or copy it into an `instance` label in the SQS rules.

## Replication checklist

1. IAM role attached (if AWS).
2. `yace-config.yml`: region + jobs for the new service.
3. `docker-compose.yml`: `yace` on the **shared network** (declared on service + root).
4. `prometheus.yml`: targets + labels; `rule_files` pointing at `alerts.d/`.
5. `alerts.d/`: **real queue label confirmed**, resource regex, thresholds, business metrics.
6. `alertmanager.yml`: destination webhooks.
7. `.env`: credentials, `GITHUB_REPO`, chat webhook.
8. Controlled test fire, then remove the test rule.

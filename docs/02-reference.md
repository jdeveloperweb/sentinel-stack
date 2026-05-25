# Technical Reference

> For engineers maintaining or extending Sentinel Stack. For setup, see the [Install Manual](INSTALL.md).

## 1. Why this architecture, not just CloudWatch?

A fair question: AWS already has CloudWatch Alarms and Dashboards. If your infra were 100% AWS and you had no application metrics, CloudWatch alone might suffice. Three reasons justify the extra layer:

**1. Your most valuable metrics aren't in CloudWatch.** Applications expose business metrics (health scores, processing failures, SLA compliance) via Micrometer/Actuator or prom-client. CloudWatch can't see them unless you pay for custom metrics. Prometheus scrapes them for free at `/metrics`. The moment you want to alert on application health — not just AWS infra — you already need more than CloudWatch.

**2. Portability and no lock-in.** CloudWatch Alarms only knows AWS metrics. Prometheus + Alertmanager is the industry standard, runs anywhere (AWS, on-prem, other clouds), and the expertise transfers between jobs.

**3. Smart routing and incident management.** CloudWatch sends to an SNS topic and stops. Alertmanager does grouping, silencing, and severity routing; the on-call provider guarantees a human responds (rotations, escalation). That's incident management, not mere notification.

**The honest trade-off:** you pay with more moving parts to maintain and a steeper learning curve. You gain application metrics, independence, severity routing, and guaranteed response. For an SLA-bound service it's worth it. For a hobby project it's overkill — CloudWatch Alarms would do.

## 2. The components

### Prometheus — collection and evaluation

A time-series database with a built-in rule evaluator. It does two things: **scrapes** targets defined in `prometheus.yml` on an interval and stores the results; and **evaluates** the rules in `alerts.d/` each cycle. When an expression returns a result the alert goes `pending`; if it stays true for the `for` duration it becomes `firing` and is sent to Alertmanager. Prometheus deliberately does *not* group, silence, or route — that's Alertmanager's job.

### Alertmanager — grouping and routing

Receives firing alerts and applies notification intelligence: **grouping** (so ten queues firing become one message), **timing** (`group_wait`, `group_interval`, `repeat_interval`), **routing** (`route` + `receivers` — this is where "critical → on-call; warning → chat only" lives), and **silencing** during maintenance. In this stack the default receiver posts to the relay; a sub-route sends criticals to both on-call and the relay.

### relay — AI triage and notification

A small, home-grown Node.js service. It receives the Alertmanager webhook at `POST /alert` and, per alert:

1. **Calls an LLM** (`triageWithAI`) with a prompt instructing it to act as an SRE and reply with **JSON only**: `analysis` (explanation + fixes), `create_issue` (boolean), `priority`. Model and timeout are configurable via env.
2. **Builds the chat message** with name, severity, service, env, summary, description, the AI analysis, and the issue link if any.
3. **Decides the issue:** if `create_issue` is true, opens a GitHub issue (when `ENABLE_GITHUB_ISSUES=true`).
4. **Posts to chat.**

Key technical points:

- **The AI decides the issue, not a fixed rule.** The code obeys the model's `create_issue` field. The prompt steers the model to only create issues for real problems and ignore noise.
- **Fail-open.** If the LLM call errors (timeout, bad key), the relay falls back to a default triage and **still delivers the alert** to chat. The pipeline never depends on the AI.
- **Everything is env-driven.** No secrets in code. Flags `ENABLE_AI_TRIAGE` and `ENABLE_GITHUB_ISSUES` let you run it bare (just a chat forwarder) or fully loaded.

**Known trade-offs** (worth documenting for maintainers): fully automatic AI-decided issues can create **noise** (duplicates for recurring incidents, false positives) — there's no dedup or cooldown today; consider requiring `severity=critical` as an extra gate, or adding dedup. The AI only receives `alertname`, `severity`, `summary`, `description`, so analysis quality depends on well-written annotations.

### On-call provider

Whatever you point `ONCALL_WEBHOOK_URL` at (iLert, PagerDuty events API, Opsgenie…). It solves what Alertmanager can't: **guaranteeing a human responds** — rotations, phone/SMS/push, and escalation to the next person if no one acknowledges. The difference between "I notified" and "I ensured someone acted."

### YACE — generic CloudWatch exporter

`yet-another-cloudwatch-exporter` translates CloudWatch metrics into Prometheus format. **It is not SQS-specific** — any CloudWatch namespace (AWS/SQS, AWS/EC2, AWS/RDS, AWS/ApplicationELB, AWS/Lambda…) can be exported. Each AWS service is a **job** in `yace-config.yml`. To monitor more services, add more job blocks — no new IAM, because the policy is generic. Metrics are exposed as `aws_<service>_<metric>_<statistic>`.

## 3. How a metric becomes an alert

1. Source publishes the number (`/metrics`).
2. Prometheus scrapes and stores the series.
3. Prometheus evaluates the rule's `expr` each cycle.
4. If true, the alert is **`pending`** and the `for` timer starts.
5. If still true after `for`, it becomes **`firing`**.
6. Prometheus sends it to Alertmanager.
7. Alertmanager groups, applies the route, dispatches to receivers.
8. relay → chat; on-call provider → pager.
9. When the `expr` stops being true, the alert **resolves** (and, with `send_resolved`, a resolution is sent).

## 4. Anatomy of an alert rule

```yaml
- alert: SQSBacklogHigh                                   # name
  expr: aws_sqs_approximate_number_of_messages_visible_average > 100   # condition (PromQL)
  for: 5m                                                 # must persist this long
  labels: { severity: warning }                           # routing + identity
  annotations:                                            # human text in the notification
    summary: "Backlog building up ({{ $labels.dimension_QueueName }})"
    description: "{{ $value | humanize }} visible messages for >5m."
```

`expr` is a PromQL query returning zero or more series (one alert instance per series). `for` filters out momentary spikes. `labels` drive routing (`severity` is key). `annotations` are free text with Go templating (`{{ $value | humanizeDuration }}`).

## 5. Labels and the `dimension_QueueName` gotcha

In Prometheus a metric is identified by its name **plus** its label set. Filtering by label (`{key="value"}` or `{key=~"regex"}`) chooses which series a rule watches.

**Real gotcha:** in this YACE build the queue label is **`dimension_QueueName`**, not `queue_name`. Many internet examples use `queue_name`, which **doesn't exist** here — a rule filtering on it never fires. Always confirm the real label by inspecting `/metrics` before writing filters:

```bash
curl -s localhost:5000/metrics | grep aws_sqs | head
```

## 6. The golden signal for FIFO queues

For FIFO queues with a fixed `MessageGroupId`, the best problem signal is **not** backlog size — it's the **age of the oldest message**: `aws_sqs_approximate_age_of_oldest_message_maximum`.

Why: in FIFO, messages in the same group are processed serially. One stuck message blocks everything behind it (*head-of-line blocking*). Backlog can look small while the system is effectively stalled. Oldest-message age rising and not falling reveals the stall even at low backlog. That's why the stack ships a dedicated head-of-line-blocking alert, and the age alerts exclude the DLQ by regex (messages sit there on purpose).

## 7. IAM and cost

**IAM:** on EC2, attach the policy as an **instance role** rather than access keys — no secret to leak. The minimal policy (in [`iam-policy.json`](iam-policy.json)) is generic for any namespace: `cloudwatch:GetMetricData`, `ListMetrics`, `GetMetricStatistics`, `tag:GetResources`.

**Cost:** YACE uses CloudWatch `GetMetricData`, billed per request (~US$0.01 per 1,000). YACE batches up to 500 metrics per call, so even scanning dozens of resources costs cents per month. Filtering (`searchTags` or at the alert level) reduces **noise**, not cost meaningfully — so filter in alerts (free) and use tags only for readability or at very large scale.

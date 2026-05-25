# I built an alerting pipeline that triages itself with AI — here's the whole thing

*A walkthrough of Sentinel Stack: Prometheus + Alertmanager + a tiny LLM-powered relay that reads each alert, rates it, and decides whether to wake someone up. Plus the Docker networking scars I earned along the way.*

---

## The 3 a.m. problem

Every team eventually learns the same lesson: the worst way to find out your service is down is a customer telling you. The second worst is a monitoring system that cries wolf so often you've muted the channel.

I wanted something in between — a pipeline that (a) watches both my application and my cloud infrastructure, (b) only escalates the things that actually matter, and (c) hands me a useful, human summary instead of a cryptic `expr` and a number. The result is **Sentinel Stack**, and this post is the story of building it, including the parts that went wrong.

## The shape of the thing

The architecture is deliberately boring, because boring is what survives an incident at 3 a.m.:

```
  App     ─┐
           ├─→  Prometheus  ─→  Alertmanager  ─┬─→  relay  ─→  Chat
  AWS/YACE ─┘    (watch)         (route)       │    (AI + issue)
                                               └─→  on-call (paging)
```

Two metric sources feed one watcher. Prometheus evaluates rules and, when one trips, forwards to Alertmanager, which groups and routes. Warnings go to chat; criticals also page on-call. The only non-standard piece is the **relay** — and that's where the fun is.

## Two sources, one brain

The first realization that shaped the design: **my most important metrics were never going to be in CloudWatch.** Queue depth and CPU live there, sure. But "how many documents did we process," "what's our internal health score," "are we breaching SLA" — those come from the application itself, exposed in Prometheus format.

So Prometheus scrapes the app directly, and a generic CloudWatch exporter (**YACE**) brings the AWS side in. One important thing about YACE that took me a moment to internalize: **it isn't a queue tool.** It's a generic bridge. SQS was just my first job; adding EC2 or RDS is one config block away, with no new IAM. That reframing made the whole stack feel less like "queue monitoring" and more like "a pipeline that happens to include a queue."

## The relay: where AI earns its keep

Alertmanager can post a webhook, but a raw alert payload is not what you want pinging your phone. So the relay sits at the end and does three things per alert:

1. Asks an LLM to act as an SRE and return strict JSON: a short analysis with likely fixes, a `create_issue` boolean, and a priority.
2. Formats a readable chat message.
3. If the model says so, opens a GitHub issue automatically.

The design rule I'm proudest of is **fail-open**: the AI only *enriches*. If the model call times out or the key is bad, the relay falls back to a default triage and still delivers the alert. I never want the clever part to be the reason a real alert went silent. In code it's just a `try/catch` that returns a fallback object — but it's a discipline, not an accident.

There's an honest trade-off here, and the repo documents it: letting the AI auto-file issues can get noisy — duplicates for a recurring incident, the occasional false positive. There's no dedup or cooldown yet. It's off by default for that reason, and the docs suggest gating it behind `severity=critical` if you turn it on. AI in the loop is a feature, not a guarantee.

## The FIFO golden signal

One genuinely useful lesson came from a FIFO queue. The instinct is to alert on backlog size — too many messages waiting. But FIFO with a single message group processes serially, so **one stuck message blocks everything behind it** (head-of-line blocking), and the backlog can look perfectly healthy while the system is effectively frozen.

The signal that actually catches this is the **age of the oldest message**. If it climbs and doesn't come back down, something is wedged — regardless of how many messages are queued. Sentinel ships a dedicated head-of-line-blocking alert built on that metric, and excludes dead-letter queues (where messages sit on purpose). It's the kind of thing you only learn by watching a queue lie to you.

## The Docker scars

No honest build log skips the part where everything broke. Three Docker lessons earned the hard way, all now in the troubleshooting guide:

**The bind-mount inode trap.** I edited a mounted rules file with `sed -i`, reloaded, and… nothing changed. The host file had my edits; the container saw the old content. The cause: a bind-mount points at the file's *inode*, and `sed -i` (like regenerating a file) creates a *new* inode. The container stays bound to the old one. `md5sum` inside vs outside the container confirmed the divergence; `docker restart` fixed it by re-reading on boot. Reload alone can't save you from this.

**Cross-network DNS.** My exporter was `Up`, but Prometheus insisted `lookup yace ... no such host`. They were on different Docker networks — and containers only resolve each other by name when they share one. The exporter had been started in a way that dropped it onto `default` while everything else lived on the project network. The permanent fix was declaring the shared network on the service explicitly. (Bonus gotcha: the real network name carries the folder prefix — `sentinel` becomes `myproject_sentinel`.)

**`--force-recreate` is a blunt instrument.** Recreating one service to pick up a config change desynced the network's internal DNS and knocked *another* service's target offline. For "just re-read this file," `docker restart` is the scalpel; `--force-recreate` is the hammer.

None of these are exotic. They're the everyday friction of wiring containers together — which is exactly why they belong in the docs.

## How to test something that's supposed to stay quiet

A working alerting pipeline is, by design, silent. So how do you prove it works without an outage? A controlled fire: a temporary rule that uses a *real* metric but an always-true threshold (`>= 0`). It fires immediately, exercises the entire path — Prometheus evaluation, Alertmanager routing, relay, chat — and then you delete it. (If you forget to delete it, it fires forever, which is its own kind of lesson.) The repo ships this as `examples/test-alert.yml` and a `smoke-test.sh`.

## What you get

The whole thing is a `docker compose up` away. Config files drive everything; the relay is ~120 lines with no heavy dependencies; secrets live in `.env`. SQS works out of the box, the rest of AWS is a config block, and the AI triage is a flag you can leave off and still have a perfectly good chat-forwarding alerting stack.

It's MIT-licensed and meant to be copied. If it saves you a weekend of YAML and Docker networking, that was the point.

---

*Sentinel Stack is open source. Clone it, fork it, file an issue, or send a PR with your own alert pack. Links and docs in the [README](../README.md).*

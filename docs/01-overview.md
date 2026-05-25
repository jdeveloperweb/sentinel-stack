# Overview

> Plain-language tour of Sentinel Stack. For the technical "how", see the [Technical Reference](02-reference.md).

## What it is

Sentinel Stack is a **monitoring-and-alerting pipeline**: a set of pieces that, together, watch a service in production and tell a human when something drifts from normal — ideally *before* a customer notices.

The architecture is **generic and reusable**: it works for any service, with or without AWS, with or without queues.

## The problem it solves

Without monitoring, you find out something broke when a customer calls. With this pipeline, the system notices the problem (a queue stalled, latency spiked, the app went down) and fires a message to chat — and, for serious cases, pages on-call.

The core idea in one sentence: **something produces a number → a tool watches that number → when it leaves the normal range, someone is told.**

## How it works, simply

Think of a four-station line:

1. **Collect** — sources produce numbers (metrics): the app reports its latency and errors; AWS reports queue depth and CPU.
2. **Watch** — one tool reads those numbers continuously and compares them against rules ("if the queue passes 100 messages, that's a problem").
3. **Route** — when a rule is violated, another piece decides where the alert goes and groups similar ones so you aren't flooded.
4. **Notify** — the alert lands where the team sees it: a chat message, and for serious cases a page to whoever is on call.

## The pieces

| Piece | In one sentence |
|-------|-----------------|
| **Prometheus** | The watcher. Collects numbers and decides *when* something is wrong. |
| **Alertmanager** | The dispatcher. Decides *where* an alert goes and groups similar ones. |
| **relay** | The smart messenger. Uses an LLM to triage severity, writes the message, posts to chat, and can open a GitHub issue. |
| **On-call provider** | The pager. For serious cases, calls/notifies whoever is on duty and escalates if no one responds. |
| **YACE** | The AWS bridge. Brings metrics from AWS services (SQS, EC2, RDS…) into the watcher. |
| **Your application** | Also a source: it publishes its own health numbers (latency, errors, business metrics). |

## Two metric sources

An important point: the pipeline watches **two different origins** of numbers.

Your **application** publishes metrics about itself — how fast it responds, how many errors, business-specific counts, an internal health score. These are the most valuable signals, read straight from the app.

**AWS** publishes infrastructure metrics — queue depth, instance CPU. These live in CloudWatch, and **YACE** is the piece that brings them in. YACE isn't queue-specific: it's a generic bridge to any AWS service.

## The full flow

```
  App     ─┐
           ├─→  Prometheus  ─→  Alertmanager  ─┬─→  relay  ─→  Chat
  AWS/YACE ─┘    (watch)         (route)       │    (AI + issue)
                                               └─→  on-call (paging)
```

The app and YACE produce numbers. Prometheus watches. When a rule fires, Alertmanager dispatches: warnings go to chat; criticals also page on-call.

## Where to go next

- [**Technical Reference**](02-reference.md) — what each piece does, why this architecture over plain CloudWatch, and how the relay's AI decides to open issues.
- [**Install Manual**](INSTALL.md) — step-by-step setup, with common errors and fixes.
- [**Customization**](04-customization.md) — what to edit per file when adapting to your service.
- [**The story**](ARTICLE.md) — a blog-style write-up of how this came to be.

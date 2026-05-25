# Contributing to Sentinel Stack

Thanks for considering a contribution! This project aims to be the fastest way to
stand up a production-grade alerting pipeline, so contributions that make it more
generic, better documented, or easier to adopt are especially welcome.

## Good first contributions

- **New alert rule packs** under `config/alerts.d/` (e.g. Kafka, RabbitMQ, Postgres).
- **New YACE jobs** for other AWS services, as commented examples.
- **New chat integrations** in the relay (Slack blocks, Teams, Discord).
- **Translations** of the docs.
- **Troubleshooting entries** — if you hit a gotcha, document the fix.

## Ground rules

1. Keep it **generic**. No company names, real endpoints, CNPJs, account IDs, or
   secrets. Use `<PLACEHOLDERS>` and `.env`.
2. Keep it **documented**. New features need a line in the README and, where relevant,
   in `docs/`.
3. Validate config before opening a PR:
   ```bash
   docker run --rm -v "$PWD/config:/c" prom/prometheus:v3.1.0 \
     promtool check config /c/prometheus.yml
   docker run --rm -v "$PWD/config/alerts.d:/r" prom/prometheus:v3.1.0 \
     promtool check rules /r/*.yml
   ```
4. One logical change per PR. Small PRs get merged faster.

## Local development

```bash
cp .env.example .env
docker compose up -d
# relay logs:
docker logs -f relay
```

## Code style

- YAML: 2-space indent, comments explaining non-obvious choices.
- JS: keep the relay dependency-light and readable over clever.

By contributing you agree your work is licensed under the [MIT License](LICENSE).

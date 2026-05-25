# Security Policy

## Secrets

Sentinel Stack **never** stores credentials in tracked files. Everything sensitive
(API keys, tokens, webhooks) loads from environment variables via `.env`, which is
git-ignored. Use `.env.example` as the template.

If a secret ever lands in your git history:

1. **Rotate it immediately.** Assume it is compromised — providers like OpenAI and
   GitHub scan public repos and auto-revoke leaked keys, but attackers scan faster.
2. Remove it from history (`git filter-repo` or BFG) and force-push.
3. Audit for unauthorized use.

## Least privilege

- For AWS, attach the IAM policy in [`docs/iam-policy.json`](docs/iam-policy.json) to an
  **instance role** rather than minting access keys. It grants read-only CloudWatch +
  tag discovery, nothing more.
- The GitHub token only needs `repo` scope (issues). Scope it down if possible.

## Reporting a vulnerability

Open a private security advisory on the repository, or email the maintainers listed in
`CODEOWNERS`. Please do not file public issues for security problems.

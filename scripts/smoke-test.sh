#!/usr/bin/env bash
# ============================================================================
# Sentinel Stack — smoke test
# Validates configs and (optionally) injects a test alert into Alertmanager
# so you can confirm the path to chat without a real incident.
# Usage:  ./scripts/smoke-test.sh
# ============================================================================
set -euo pipefail

PROM=${PROM:-http://localhost:9090}
ALERTMGR=${ALERTMGR:-http://localhost:9093}

echo "▶ Checking Prometheus targets…"
curl -s "$PROM/api/v1/targets" \
  | python3 -c "import sys,json; [print('  ',t['labels'].get('job'),'->',t['health']) for t in json.load(sys.stdin)['data']['activeTargets']]"

echo "▶ Checking loaded rules…"
curl -s "$PROM/api/v1/rules" \
  | python3 -c "import sys,json; d=json.load(sys.stdin)['data']['groups']; print('  ', sum(len(g['rules']) for g in d), 'rules across', len(d), 'groups')"

echo "▶ Injecting a test alert into Alertmanager…"
curl -s -H "Content-Type: application/json" -d '[{
  "labels": {"alertname":"SmokeTest","severity":"warning","service":"sentinel","env":"test"},
  "annotations": {"summary":"Smoke test","description":"If this reaches chat, the pipeline works."}
}]' "$ALERTMGR/api/v2/alerts" >/dev/null && echo "  sent."

echo "✓ Done. Check your chat channel for the SmokeTest message."

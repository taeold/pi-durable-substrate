#!/usr/bin/env bash
# End-to-end walkthrough for pi-durable on Agent Substrate.
set -euo pipefail

ROUTER_URL="${ROUTER_URL:-http://localhost:8000}"
ATESPACE="${ATESPACE:-ate-demo-pi}"
TEMPLATE="${TEMPLATE:-pi-durable-data}"
ACTOR="${ACTOR:-demo-agent}"
FORK_ACTOR="${FORK_ACTOR:-demo-agent-fork}"
TAG="${TAG:-checkpoint-v1}"

echo "=== 1. Create actor ${ATESPACE}/${ACTOR} ==="
kubectl ate create actor "${ACTOR}" --template "${TEMPLATE}" -a "${ATESPACE}"
kubectl ate create egress-policy "${ACTOR}" -a "${ATESPACE}" -f egress-policy.yaml

echo "=== 2. Send Turn 1 prompt (auto-resumes actor via atenet-router) ==="
curl -sS -X POST "${ROUTER_URL}/submit" \
  -H "ate-target-actor: ${ATESPACE}/${ACTOR}" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Turn 1: scaffold app.js and test.js"}' | jq .

echo "=== 3. Suspend actor ${ATESPACE}/${ACTOR} (snapshots /workspace + SQLite) ==="
kubectl ate suspend actor "${ACTOR}" -a "${ATESPACE}"

echo "=== 4. Tag snapshot as '${TAG}' and fork '${FORK_ACTOR}' ==="
kubectl ate create tag "${TAG}" --actor "${ACTOR}" -a "${ATESPACE}"
kubectl ate create actor "${FORK_ACTOR}" --template "${TEMPLATE}" --tag "${TAG}" -a "${ATESPACE}"
kubectl ate create egress-policy "${FORK_ACTOR}" -a "${ATESPACE}" -f egress-policy.yaml

echo "=== 5. Send divergent Turn 2 prompts to both ${ACTOR} and ${FORK_ACTOR} ==="
curl -sS -X POST "${ROUTER_URL}/submit" \
  -H "ate-target-actor: ${ATESPACE}/${ACTOR}" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Turn 2 (Branch A): add multiply() and production logging"}' | jq .

curl -sS -X POST "${ROUTER_URL}/submit" \
  -H "ate-target-actor: ${ATESPACE}/${FORK_ACTOR}" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Turn 2 (Branch B): add multiply() and benchmark suite"}' | jq .

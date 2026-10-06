#!/usr/bin/env bash
# End-to-end verification walkthrough for pi-durable on Agent Substrate.
#
# Prerequisites:
#   1. Agent Substrate cluster running (kind or GKE) with `ate-demo-pi` deployed
#   2. `kubectl port-forward -n ate-system svc/atenet-router 8000:80` active
#   3. `kubectl-ate` (`kubectl ate`) and `jq` in PATH
set -euo pipefail

ROUTER_URL="${ROUTER_URL:-http://localhost:8000}"
ATESPACE="${ATESPACE:-ate-demo-pi}"
TEMPLATE="${TEMPLATE:-pi-durable-data}"
ACTOR="${ACTOR:-demo-agent}"
FORK_ACTOR="${FORK_ACTOR:-demo-agent-fork}"
TAG="${TAG:-checkpoint-v1}"

echo "================================================================================"
echo "1. Create actor ${ATESPACE}/${ACTOR} from template ${TEMPLATE}"
echo "================================================================================"
kubectl ate create actor "${ACTOR}" --template "${TEMPLATE}" -a "${ATESPACE}"

echo ""
echo "================================================================================"
echo "2. Send Turn 1 prompt (auto-resumes actor from golden snapshot via atenet-router)"
echo "================================================================================"
curl -sS -X POST "${ROUTER_URL}/submit" \
  -H "ate-target-actor: ${ATESPACE}/${ACTOR}" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Turn 1: scaffold app.js"}' \
  | jq '{submissionId, processBootId: .state.processBootId, sqliteSizeBytes: .state.sqliteSizeBytes, entryCount: .state.transcriptSummary.entryCount, workspaceFiles: .state.workspaceFiles}'

echo ""
echo "================================================================================"
echo "3. Suspend actor ${ATESPACE}/${ACTOR} (snapshots /workspace + SQLite to object storage)"
echo "================================================================================"
kubectl ate suspend actor "${ACTOR}" -a "${ATESPACE}"

echo ""
echo "================================================================================"
echo "4. Tag snapshot as '${TAG}' and fork a second actor '${FORK_ACTOR}' from '${TAG}'"
echo "================================================================================"
kubectl ate create tag "${TAG}" --actor "${ACTOR}" -a "${ATESPACE}"
kubectl ate create actor "${FORK_ACTOR}" --template "${TEMPLATE}" --tag "${TAG}" -a "${ATESPACE}"
kubectl ate get tags "${TAG}" -a "${ATESPACE}"

echo ""
echo "================================================================================"
echo "5. Send divergent Turn 2 prompts to both ${ACTOR} and ${FORK_ACTOR}"
echo "================================================================================"
echo "--- Branch A (${ACTOR}) ---"
curl -sS -X POST "${ROUTER_URL}/submit" \
  -H "ate-target-actor: ${ATESPACE}/${ACTOR}" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Turn 2 (Branch A - Original): add multiply() and production logging"}' \
  | jq '{actor: "'"${ACTOR}"'", processBootId: .state.processBootId, entryCount: .state.transcriptSummary.entryCount, appJs: .state.workspaceFiles["app.js"]}'

echo "--- Branch B (${FORK_ACTOR}) ---"
curl -sS -X POST "${ROUTER_URL}/submit" \
  -H "ate-target-actor: ${ATESPACE}/${FORK_ACTOR}" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Turn 2 (Branch B - Forked from checkpoint-v1): add multiply() and experimental benchmark harness"}' \
  | jq '{actor: "'"${FORK_ACTOR}"'", processBootId: .state.processBootId, entryCount: .state.transcriptSummary.entryCount, appJs: .state.workspaceFiles["app.js"]}'

echo ""
echo "================================================================================"
echo "6. Test Mid-Turn Steering (POST /submit with wait:false + POST /steer)"
echo "================================================================================"
curl -sS -X POST "${ROUTER_URL}/submit" \
  -H "ate-target-actor: ${ATESPACE}/${ACTOR}" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Turn 3 (slow): refactor with delay", "wait": false}' \
  | jq '{action, submissionId, activeTasks: .state.inspection.activeTasks}'

curl -sS -X POST "${ROUTER_URL}/steer" \
  -H "ate-target-actor: ${ATESPACE}/${ACTOR}" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Steer mid-turn: export steered flag in test.js", "wait": true}' \
  | jq '{action, submissionId, testJs: .state.workspaceFiles["test.js"]}'

echo ""
echo "================================================================================"
echo "7. Live Actor & Worker State"
echo "================================================================================"
kubectl ate get actors -a "${ATESPACE}"

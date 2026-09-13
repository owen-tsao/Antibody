#!/usr/bin/env bash
# Antibody dev: FastAPI on :8000 + Vite on :5173 (proxies /api -> 8000).
# Ctrl-C stops both. ANTIBODY_LOOP_CMD passes through to the API (e.g. "sleep 30" to test Start without tokens).
# The API runs without --reload on purpose: a reload mid-run drops the handle on the loop it spawned, and
# the UI then loses Stop for that run. Set ANTIBODY_RELOAD=1 while editing api/ to get it back.
set -euo pipefail
cd "$(dirname "$0")/.."

RELOAD=()
[ -n "${ANTIBODY_RELOAD:-}" ] && RELOAD=(--reload)
uv run uvicorn api.main:app --port 8000 ${RELOAD[@]+"${RELOAD[@]}"} &
API_PID=$!
npm --prefix web run dev &
WEB_PID=$!

trap 'kill "$API_PID" "$WEB_PID" 2>/dev/null; wait "$API_PID" "$WEB_PID" 2>/dev/null || true' INT TERM EXIT

echo
echo "  web  http://localhost:5173"
echo "  api  http://localhost:8000/api/state"
[ -n "${ANTIBODY_LOOP_CMD:-}" ] && echo "  loop command override: $ANTIBODY_LOOP_CMD"
echo

wait -n "$API_PID" "$WEB_PID" 2>/dev/null || wait "$API_PID" "$WEB_PID"

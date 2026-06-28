#!/usr/bin/env bash
#
# Run the integration test suite with host-api available in the background.
# Project containers reach the rendering gateway at host.docker.internal:<port>,
# so the API must be up before the test starts a project. The API (and any
# projects the test leaves running) are torn down on exit.
set -uo pipefail

cd "$(dirname "$0")/.."

HOST_PORT="${HOST_PORT:-3100}"
API_PID=""

cleanup() {
	if [[ -n "$API_PID" ]]; then
		echo "[integration] Stopping host-api (pid $API_PID) and children..."
		# Kill the process tree: children first, then the wrapper
		pkill -P "$API_PID" 2>/dev/null || true
		kill "$API_PID" 2>/dev/null || true
		wait "$API_PID" 2>/dev/null || true
	fi
	bun run scripts/stop-all-projects.ts || true
}
trap cleanup EXIT

echo "[integration] Starting host-api on port $HOST_PORT..."
HOST_PORT="$HOST_PORT" bun run --filter @agent-manager/host-api start &
API_PID=$!

# Wait for the API health endpoint (max ~30s).
for _ in $(seq 1 60); do
	if curl -sf "http://localhost:${HOST_PORT}/health" >/dev/null 2>&1; then
		echo "[integration] host-api is ready."
		break
	fi
	if ! kill -0 "$API_PID" 2>/dev/null; then
		echo "[integration] host-api exited before becoming ready." >&2
		exit 1
	fi
	sleep 0.5
done

if ! curl -sf "http://localhost:${HOST_PORT}/health" >/dev/null 2>&1; then
	echo "[integration] host-api did not become ready in time." >&2
	exit 1
fi

echo "[integration] Running integration tests..."
bun run tests/integration.test.ts

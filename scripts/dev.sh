#!/usr/bin/env bash
#
# Host dev stack: runs host-api + host-web together. When this script
# exits (Ctrl-C, terminal close, etc.) it also stops every running project
# container, so downing the dev stack downs the projects it manages.
#
# The watch-restart of host-api happens *inside* the bun process, so it does
# not trigger this trap — only stopping the whole dev script does.
set -uo pipefail

cd "$(dirname "$0")/.."

echo "[dev] Starting shared infrastructure (lancedb, chromium)..."
docker compose up -d --wait
echo "[dev] Infrastructure ready."

cleanup() {
	echo ""
	echo "[dev] Shutting down — stopping all running projects..."
	bun run scripts/stop-all-projects.ts || true
}
trap cleanup EXIT

bunx concurrently --kill-others-on-fail --names "api,web" \
	"bun run dev:api" \
	"bun run dev:web"

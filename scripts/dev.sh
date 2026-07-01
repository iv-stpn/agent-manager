#!/usr/bin/env bash
#
# Orchestrator dev stack: runs api + web together. When this script
# exits (Ctrl-C, terminal close, etc.) it also stops every running project
# container, so downing the dev stack downs the projects it manages.
#
# The watch-restart of api happens *inside* the bun process, so it does
# not trigger this trap — only stopping the whole dev script does.
set -uo pipefail

cd "$(dirname "$0")/.."

if ! command -v docker >/dev/null 2>&1; then
	echo "[dev] ERROR: docker was not found on your PATH." >&2
	echo "[dev] Install Docker (or start the Docker daemon) and try again." >&2
	exit 1
fi
if ! docker info >/dev/null 2>&1; then
	echo "[dev] ERROR: docker is installed but the daemon is not running." >&2
	echo "[dev] Start the Docker daemon and try again." >&2
	exit 1
fi

echo "[dev] Starting shared infrastructure (lancedb, chromium)..."
docker compose up -d --wait
echo "[dev] Infrastructure ready."

cleanup() {
	echo ""
	echo "[dev] Shutting down — stopping all running projects..."
	bun run scripts/stop-all-projects.ts || true

	# concurrently only signals its *direct* children, so grandchildren
	# (bun --watch, vite, esbuild/rollup workers) get reparented to init
	# and linger — still holding the terminal's foreground group, so the
	# prompt never returns. Reap anything left in our process group
	# (sparing this script), escalating TERM → KILL. Only do this when we
	# are our own group leader (the normal interactive case); otherwise
	# the group is shared with a parent shell and we leave it alone.
	if [ "$(ps -o pgid= -p $$ | tr -d ' ')" = "$$" ]; then
		pids=$(pgrep -g "$$" 2>/dev/null | grep -v "^$$\$" || true)
		if [ -n "$pids" ]; then
			kill -TERM $pids 2>/dev/null || true
			sleep 0.5
			kill -KILL $pids 2>/dev/null || true
		fi
	fi
}
trap cleanup EXIT

bunx concurrently --kill-others-on-fail --names "api,web" \
	"bun run dev:api" \
	"bun run dev:web"

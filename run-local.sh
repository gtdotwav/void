#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

echo "[run-local] starting backend+frontend unified server on http://localhost:8787"
echo "[run-local] press Ctrl+C to stop"
echo "[run-local] log file: /tmp/jv-backend.log"
node server.mjs 2>&1 | tee /tmp/jv-backend.log

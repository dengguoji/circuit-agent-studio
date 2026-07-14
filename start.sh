#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"

BACKEND_HOST="${BACKEND_HOST:-127.0.0.1}"
BACKEND_PORT="${BACKEND_PORT:-8787}"
FRONTEND_PORT="${FRONTEND_PORT:-5178}"
FRONTEND_HOST="${FRONTEND_HOST:-127.0.0.1}"
PYTHON_BIN="${PYTHON_BIN:-python3}"

BACKEND_PID=""
FRONTEND_PID=""
REQUIREMENTS_STAMP="$BACKEND_DIR/.venv/.requirements.sha256"

log() {
  printf '[circuit-agent-studio] %s\n' "$*"
}

has_command() {
  command -v "$1" >/dev/null 2>&1
}

is_backend_ready() {
  curl -fsS "http://localhost:${BACKEND_PORT}/api/health" >/dev/null 2>&1
}

is_frontend_ready() {
  curl -fsSI "http://localhost:${FRONTEND_PORT}/" >/dev/null 2>&1
}

cleanup() {
  if [[ -n "$FRONTEND_PID" ]] && kill -0 "$FRONTEND_PID" >/dev/null 2>&1; then
    kill "$FRONTEND_PID" >/dev/null 2>&1 || true
  fi
  if [[ -n "$BACKEND_PID" ]] && kill -0 "$BACKEND_PID" >/dev/null 2>&1; then
    kill "$BACKEND_PID" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT INT TERM

if ! has_command curl; then
  log "curl is required."
  exit 1
fi

if ! has_command npm; then
  log "npm is required."
  exit 1
fi

if [[ ! -x "$BACKEND_DIR/.venv/bin/python" ]]; then
  log "backend .venv not found, creating it..."
  "$PYTHON_BIN" -m venv "$BACKEND_DIR/.venv"
fi

if [[ ! -d "$FRONTEND_DIR/node_modules" ]] || [[ "$FRONTEND_DIR/package-lock.json" -nt "$FRONTEND_DIR/node_modules/.package-lock.json" ]]; then
  log "installing frontend dependencies..."
  (cd "$FRONTEND_DIR" && npm install)
fi

REQUIREMENTS_HASH="$($PYTHON_BIN - "$BACKEND_DIR/requirements.txt" <<'PY'
from hashlib import sha256
from pathlib import Path
import sys

print(sha256(Path(sys.argv[1]).read_bytes()).hexdigest())
PY
)"

if ! "$BACKEND_DIR/.venv/bin/python" - <<'PY' >/dev/null 2>&1
import openai
import langgraph
import langsmith
import yaml
PY
then
  BACKEND_DEPENDENCIES_READY=false
elif [[ ! -f "$REQUIREMENTS_STAMP" ]] || [[ "$(<"$REQUIREMENTS_STAMP")" != "$REQUIREMENTS_HASH" ]]; then
  BACKEND_DEPENDENCIES_READY=false
else
  BACKEND_DEPENDENCIES_READY=true
fi

if [[ "$BACKEND_DEPENDENCIES_READY" != true ]]
then
  log "installing backend dependencies..."
  "$BACKEND_DIR/.venv/bin/pip" install -r "$BACKEND_DIR/requirements.txt"
  printf '%s\n' "$REQUIREMENTS_HASH" > "$REQUIREMENTS_STAMP"
fi

if is_backend_ready; then
  log "backend already running at http://localhost:${BACKEND_PORT}"
else
  log "starting backend at http://${BACKEND_HOST}:${BACKEND_PORT}"
  (cd "$BACKEND_DIR" && "$BACKEND_DIR/.venv/bin/python" -u server.py) &
  BACKEND_PID="$!"
fi

if is_frontend_ready; then
  log "frontend already running at http://localhost:${FRONTEND_PORT}"
else
  log "starting frontend at http://localhost:${FRONTEND_PORT}"
  (cd "$FRONTEND_DIR" && npm run dev -- --host "$FRONTEND_HOST" --port "$FRONTEND_PORT") &
  FRONTEND_PID="$!"
fi

log "waiting for services..."
for _ in {1..60}; do
  if is_backend_ready && is_frontend_ready; then
    log "ready: http://localhost:${FRONTEND_PORT}/"
    log "backend: http://localhost:${BACKEND_PORT}/api/health"
    if [[ -z "$BACKEND_PID" && -z "$FRONTEND_PID" ]]; then
      exit 0
    fi
    wait
    exit 0
  fi
  sleep 0.5
done

log "service startup timed out."
exit 1

#!/usr/bin/env bash
set -euo pipefail

AGENT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
[ ! -f "$AGENT_ROOT/.env" ] || { set -a; source "$AGENT_ROOT/.env"; set +a; }

KNOWLEDGE_BASE_ROOT="${S8_KB_ROOT:-$AGENT_ROOT/../854_md}"
case "$KNOWLEDGE_BASE_ROOT" in
    /*) ;;
    *) KNOWLEDGE_BASE_ROOT="$AGENT_ROOT/$KNOWLEDGE_BASE_ROOT" ;;
esac
KNOWLEDGE_BASE_ROOT="$(cd -- "$KNOWLEDGE_BASE_ROOT" && pwd -P)"
export S8_KB_ROOT="$KNOWLEDGE_BASE_ROOT"
export PI_CODING_AGENT_DIR="$AGENT_ROOT/.pi-runtime"
export S8_PI_BINARY="$AGENT_ROOT/pi/node_modules/.bin/pi"
export S8_PI_CONFIG_ROOT="$AGENT_ROOT/pi"

[ -x "$S8_PI_BINARY" ] || { echo 'Pi is not installed; run npm ci --ignore-scripts --prefix pi.' >&2; exit 1; }
cd "$KNOWLEDGE_BASE_ROOT"
exec node "$AGENT_ROOT/pi/bin/scheduler.mjs"

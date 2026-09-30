#!/usr/bin/env bash
set -euo pipefail

AGENT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
KNOWLEDGE_BASE_ROOT="${S8_KB_ROOT:-$AGENT_ROOT/../854_md}"
KNOWLEDGE_BASE_ROOT="$(cd -- "$KNOWLEDGE_BASE_ROOT" && pwd -P)"
PI_CONFIG_ROOT="$AGENT_ROOT/pi"
PI_CODING_AGENT_DIR="$AGENT_ROOT/.pi-runtime"
PI_WEB_CWD="${PI_WEB_CWD:-$KNOWLEDGE_BASE_ROOT}"
PI_WEB_HOST="${PI_WEB_HOST:-127.0.0.1}"
PI_WEB_PORT="${PI_WEB_PORT:-8788}"
PI_WEB_DATA_DIR="${PI_WEB_DATA_DIR:-$AGENT_ROOT/.s8-runtime/pi-web-ui}"

[ -x "$PI_CONFIG_ROOT/node_modules/.bin/pi" ] || {
    printf '%s\n' '오류: Pi가 설치되지 않았습니다. npm ci --ignore-scripts --prefix pi를 실행하세요.' >&2
    exit 1
}

mkdir -p "$PI_CODING_AGENT_DIR" "$PI_WEB_DATA_DIR"
chmod 700 "$PI_CODING_AGENT_DIR" "$PI_WEB_DATA_DIR"
if [ -L "$PI_CODING_AGENT_DIR/settings.json" ]; then
    [ "$(readlink "$PI_CODING_AGENT_DIR/settings.json")" = "$PI_CONFIG_ROOT/settings.json" ] || {
        printf '%s\n' '오류: 런타임 설정 링크가 공유 설정을 가리키지 않습니다.' >&2
        exit 1
    }
elif [ -e "$PI_CODING_AGENT_DIR/settings.json" ]; then
    printf '%s\n' '오류: 런타임 설정 파일이 이미 있습니다. 덮어쓰지 않습니다.' >&2
    exit 1
else
    ln -s "$PI_CONFIG_ROOT/settings.json" "$PI_CODING_AGENT_DIR/settings.json"
fi

export PI_CODING_AGENT_DIR PI_WEB_CWD PI_WEB_HOST PI_WEB_PORT PI_WEB_DATA_DIR PI_TELEMETRY=0

cd "$KNOWLEDGE_BASE_ROOT"
exec npx -y pi-web-ui@0.96.1 --agent-dir "$PI_CODING_AGENT_DIR" "$@"

#!/usr/bin/env bash
set -euo pipefail

AGENT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
if [[ "${1:-}" == --help || "${1:-}" == -h ]]; then
    printf '%s\n' \
        '사용법: ./start-pi.sh [Pi 옵션]' \
        '  (인자 없음)      Pi 터미널 및 Telegram 연동 실행' \
        '  --help, -h       이 도움말 표시' \
        '  그 외 인자는 Pi CLI에 전달합니다. Pi 옵션: pi/node_modules/.bin/pi --help' \
        '  Telegram 설정: TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USER_IDS / TELEGRAM_ALLOWED_GROUP_IDS' \
        '  작업 디렉터리: S8_KB_ROOT (기본값: ../854_md)'
    exit 0
fi
[ ! -f "$AGENT_ROOT/.env" ] || { set -a; source "$AGENT_ROOT/.env"; set +a; }
if [[ "${1:-}" == telegram ]]; then
    printf '%s\n' 'telegram 단독 실행은 지원하지 않습니다. 인자 없이 ./start-pi.sh를 실행하세요.' >&2
    exit 2
fi
KNOWLEDGE_BASE_ROOT="${S8_KB_ROOT:-$AGENT_ROOT/../854_md}"
case "$KNOWLEDGE_BASE_ROOT" in
    /*) ;;
    *) KNOWLEDGE_BASE_ROOT="$AGENT_ROOT/$KNOWLEDGE_BASE_ROOT" ;;
esac
KNOWLEDGE_BASE_ROOT="$(cd -- "$KNOWLEDGE_BASE_ROOT" && pwd -P)"
PI_CONFIG_ROOT="$AGENT_ROOT/pi"
PI_CODING_AGENT_DIR="$AGENT_ROOT/.pi-runtime"
PI_BINARY="$PI_CONFIG_ROOT/node_modules/.bin/pi"

[ -x "$PI_BINARY" ] || {
    printf '%s\n' '오류: Pi가 설치되지 않았습니다. npm ci --ignore-scripts --prefix pi를 실행하세요.' >&2
    exit 1
}

mkdir -p "$PI_CODING_AGENT_DIR"
chmod 700 "$PI_CODING_AGENT_DIR"
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
export PI_CODING_AGENT_DIR
export PI_TELEMETRY=0
export S8_PI_BINARY="$PI_BINARY"
export S8_PI_CONFIG_ROOT="$PI_CONFIG_ROOT"

cd "$KNOWLEDGE_BASE_ROOT"
case "${1:-}" in
    install|remove|uninstall|update|list|config)
        exec "$PI_BINARY" "$@"
        ;;
esac

exec "$PI_BINARY" \
    --extension "$PI_CONFIG_ROOT/extensions/s8-guard.ts" \
    --extension "$PI_CONFIG_ROOT/extensions/projectman.ts" \
    --extension "$PI_CONFIG_ROOT/extensions/telegram.mjs" \
    --skill "$PI_CONFIG_ROOT/skills/s8-operations" \
    --append-system-prompt "$PI_CONFIG_ROOT/APPEND_SYSTEM.md" \
    --tools read,bash,edit,write,grep,find,ls \
    "$@"

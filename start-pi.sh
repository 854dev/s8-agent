#!/usr/bin/env bash
set -euo pipefail

AGENT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
if [[ "${1:-}" == --help || "${1:-}" == -h ]]; then
    printf '%s\n' \
        '사용법: ./start-pi.sh [Pi 옵션]' \
        '  (인자 없음)      Telegram 없이 Pi 터미널 실행' \
        '  --telegram       Telegram 연동 실행 (Pi 옵션과 함께 사용 가능)' \
        '  --sessions       실행 중인 S8 tmux 세션 목록' \
        '  --session 이름   S8 tmux 세션 생성 또는 접속 (--telegram으로 연결 이전)' \
        '  --help, -h       이 도움말 표시' \
        '  그 외 인자는 Pi CLI에 전달합니다. Pi 옵션: pi/node_modules/.bin/pi --help' \
        '  Telegram 설정: TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USER_IDS / TELEGRAM_ALLOWED_GROUP_IDS' \
        '  작업 디렉터리: S8_KB_ROOT (기본값: ../854_md)'
    exit 0
fi
if [[ "${1:-}" == --sessions ]]; then
    node --input-type=module -e "import {listSessions} from '$AGENT_ROOT/pi/lib/managed-sessions.mjs'; console.log((await listSessions()).join('\\n') || '실행 중인 S8 세션이 없습니다.');"
    exit 0
fi
# Pi's --session file.jsonl option remains available for saved conversation files.
if [[ "${1:-}" == --telegram && "${2:-}" == --session && "${3:-}" != */* && "${3:-}" != *.jsonl ]]; then
    shift
    session_arg="${2:-}"
    shift 2
    set -- --session "$session_arg" --telegram "$@"
fi
if [[ "${1:-}" == --session && "${2:-}" != */* && "${2:-}" != *.jsonl ]]; then
    name="${2:-}"
    [[ "$name" =~ ^[A-Za-z0-9_-]{1,40}$ ]] || { echo '잘못된 세션 이름입니다.' >&2; exit 2; }
    shift 2
    session="s8-$name"
    telegram=false
    if [[ "${1:-}" == --telegram ]]; then telegram=true; shift; fi
    if ! tmux has-session -t "=$session" 2>/dev/null; then
        printf -v cmd '%q ' "$AGENT_ROOT/start-pi.sh" --managed "$@"
        tmux new-session -d -s "$session" -c "$AGENT_ROOT" "$cmd"
        tmux set-option -t "$session" @s8-managed 1
    elif [[ "$(tmux show-option -t "$session" -v @s8-managed 2>/dev/null)" != 1 ]]; then
        echo 'S8이 관리하지 않는 세션입니다.' >&2; exit 2
    elif (($# > 0)); then
        echo '기존 세션 접속 시 Pi 실행 옵션은 변경할 수 없습니다.' >&2; exit 2
    fi
    if $telegram; then
        node --input-type=module -e "import {moveTelegram} from '$AGENT_ROOT/pi/lib/managed-sessions.mjs'; await moveTelegram(process.argv[1]);" "$AGENT_ROOT/.pi-runtime/$session.sock"
    fi
    if [[ -n "${TMUX:-}" ]]; then exec tmux switch-client -t "=$session"; fi
    exec tmux attach-session -t "=$session"
fi
managed=false
if [[ "${1:-}" == --managed ]]; then managed=true; shift; fi
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
TELEGRAM_EXTENSION=''
if [[ "${1:-}" == --telegram ]]; then
    TELEGRAM_EXTENSION="$PI_CONFIG_ROOT/extensions/telegram.mjs"
    shift
fi

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
export S8_PI_RESTART_DIR="$PI_CODING_AGENT_DIR"

cd "$KNOWLEDGE_BASE_ROOT"
case "${1:-}" in
    install|remove|uninstall|update|list|config)
        exec "$PI_BINARY" "$@"
        ;;
esac

restart_args=()
while true; do
    pi_args=(
        --extension "$PI_CONFIG_ROOT/extensions/s8-guard.ts"
        --extension "$PI_CONFIG_ROOT/extensions/projectman.ts"
        --extension "$PI_CONFIG_ROOT/extensions/scheduler.ts"
    )
    if $managed; then
        managed_name="$(tmux display-message -p '#S')"
        [[ "$managed_name" =~ ^s8-[A-Za-z0-9_-]{1,40}$ ]] || { echo '관리 세션에서만 실행할 수 있습니다.' >&2; exit 2; }
        pi_args+=(--session-dir "$PI_CODING_AGENT_DIR/managed/$managed_name" --extension "$PI_CONFIG_ROOT/extensions/managed-session.mjs")
    elif [[ -n "$TELEGRAM_EXTENSION" ]]; then
        pi_args+=(--extension "$TELEGRAM_EXTENSION")
    fi
    pi_args+=(
        --skill "$PI_CONFIG_ROOT/skills/s8-operations"
        --append-system-prompt "$PI_CONFIG_ROOT/APPEND_SYSTEM.md"
        --tools read,bash,edit,write,grep,find,ls
    )
    if ((${#restart_args[@]} > 0)); then
        pi_args+=("${restart_args[@]}")
    fi
    if (($# > 0)); then
        pi_args+=("$@")
    fi

    "$PI_BINARY" "${pi_args[@]}" <&0 &
    pi_pid=$!
    if wait "$pi_pid"; then status=0; else status=$?; fi
    if [ -f "$PI_CODING_AGENT_DIR/restart-$$" ]; then
        rm -f "$PI_CODING_AGENT_DIR/restart-$$"
        restart_args=(--continue)
        continue
    fi
    exit "$status"
done

#!/usr/bin/env bash
# S8 관리 에이전트와 스케줄러·개발 감독을 기본으로 실행한다. 기본 도구는 Projectman·KB·Scheduler로 제한한다.
# 사용 예: ./start-pi.sh / ./start-pi.sh --continue / ./start-pi.sh --session manager
# --telegram은 명시한 경우에만 Telegram을 연결한다. --help로 사용법을 확인한다.
# 루트 .env의 연결 설정을 자식 프로세스에 전달하며 인증 값은 출력하지 않는다.
# 모델 인증·대화는 .pi-runtime에 보관한다. 처음 실행하면 Pi에서 /login을 수행한다.
# Pi와 두 서비스는 하나의 tmux 세션의 별도 창에서 유지된다. --no-scheduler / --no-supervisor로 자동 시작을 제외한다.
# 제외 옵션은 이미 실행 중인 공유 서비스를 종료하지 않는다.
set -euo pipefail

# 현재 터미널 위치와 관계없이 스크립트가 있는 저장소를 기준으로 경로를 계산한다.
AGENT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# 서비스 전용 진입점: 통합 실행의 tmux 자식과 수동 진단이 같은 경로를 사용한다.
if [[ "${1:-}" == --service ]]; then
    service="${2:-}"
    case "$service" in scheduler|supervisor) ;; *) echo '서비스는 scheduler 또는 supervisor여야 합니다.' >&2; exit 2 ;; esac
    shift 2
    if [[ "$service" == scheduler && $# -gt 0 ]]; then echo '스케줄러는 추가 인자를 받지 않습니다.' >&2; exit 2; fi
    if [[ "$service" == supervisor && "${1:-}" == --help ]]; then exec node "$AGENT_ROOT/pi/bin/supervisor.mjs" --help; fi
    [ ! -f "$AGENT_ROOT/.env" ] || { set -a; source "$AGENT_ROOT/.env"; set +a; }
    if [[ "$service" == scheduler ]]; then
        KNOWLEDGE_BASE_ROOT="${S8_KB_ROOT:-$AGENT_ROOT/../854_md}"
        case "$KNOWLEDGE_BASE_ROOT" in /*) ;; *) KNOWLEDGE_BASE_ROOT="$AGENT_ROOT/$KNOWLEDGE_BASE_ROOT" ;; esac
        KNOWLEDGE_BASE_ROOT="$(cd -- "$KNOWLEDGE_BASE_ROOT" && pwd -P)"
        export S8_KB_ROOT="$KNOWLEDGE_BASE_ROOT"
        export PI_CODING_AGENT_DIR="$AGENT_ROOT/.pi-runtime"
        export S8_PI_BINARY="$AGENT_ROOT/pi/node_modules/.bin/pi"
        export S8_PI_CONFIG_ROOT="$AGENT_ROOT/pi"
        [ -x "$S8_PI_BINARY" ] || { echo 'Pi is not installed; run npm ci --ignore-scripts --prefix pi.' >&2; exit 1; }
        cd "$KNOWLEDGE_BASE_ROOT"
    fi
    exec node "$AGENT_ROOT/pi/bin/$service.mjs" "$@"
fi
# 서비스 제어 옵션은 Pi에 넘기지 않고 여기서 소비한다. 옵션 위치와 관계없이 처리한다.
service_options=()
manager_options=()
for option in "$@"; do
    case "$option" in
        --no-scheduler) service_options+=(--no-scheduler) ;;
        --no-supervisor) service_options+=(--no-supervisor) ;;
        *) manager_options+=("$option") ;;
    esac
done
# Bash 3.2의 nounset에서는 빈 배열도 미설정으로 취급하므로, 값이 있을 때만 펼친다.
set -- ${manager_options[@]+"${manager_options[@]}"}
if [[ "${1:-}" == --manager ]]; then shift; fi
if [[ "${1:-}" == --help || "${1:-}" == -h ]]; then
    printf '%s\n' \
        '사용법: ./start-pi.sh [Pi 옵션]' \
        '  (인자 없음)      s8-main tmux 세션에 Pi·스케줄러·개발 감독 창 생성 후 목록 출력' \
        '  --no-scheduler   스케줄러 자동 시작 제외' \
        '  --no-supervisor  개발 슈퍼바이저 자동 시작 제외' \
        '  --service 종류   scheduler 또는 supervisor만 전경 실행 (감독 --check 지원)' \
        '  --telegram       Telegram 연동 실행 (Pi 옵션과 함께 사용 가능)' \
        '  --manager        기본 관리 역할의 별칭 (Projectman·KB·예약)' \
        '  --sessions       실행 중인 S8 tmux 세션 목록' \
        '  --session 이름   s8-이름 세션 생성·재사용 후 목록 출력 (자동 접속 없음)' \
        '  --help, -h       이 도움말 표시' \
        '  관리 역할 옵션: --continue, --print, --no-session, --version, --model, --provider, --thinking' \
        '  Telegram 인증: TELEGRAM_BOT_TOKEN (환경변수)' \
        '  Telegram ID·알림 대상: s8-config.yml (파일이 없으면 기존 ID 환경변수)' \
        '  작업 디렉터리: S8_KB_ROOT (기본값: ../854_md)'
    exit 0
fi
if [[ "${1:-}" == --sessions ]]; then
    exec node "$AGENT_ROOT/pi/bin/pi-runtime.mjs" --sessions
fi
# 대화형 실행은 백그라운드 tmux 런타임을 준비하고 목록만 출력한다.
# --managed는 런타임의 Pi 창에서만 사용하는 내부 전경 실행 옵션이다.
managed=false
if [[ "${1:-}" == --managed ]]; then
    managed=true
    shift
else
    runtime=true
    case "${1:-}" in install|remove|uninstall|update|list|config) runtime=false ;; esac
    for option in "$@"; do
        case "$option" in --version|--print) runtime=false ;; esac
    done
    if $runtime; then
        exec node "$AGENT_ROOT/pi/bin/pi-runtime.mjs" ${service_options[@]+"${service_options[@]}"} "$@"
    fi
fi
# 연결·KB 경로 설정을 로드한다. 내용이나 인증 값을 로그로 출력하지 않는다.
[ ! -f "$AGENT_ROOT/.env" ] || { set -a; source "$AGENT_ROOT/.env"; set +a; }
if [[ "${1:-}" == telegram ]]; then
    printf '%s\n' 'telegram 단독 실행은 지원하지 않습니다. 인자 없이 ./start-pi.sh를 실행하세요.' >&2
    exit 2
fi
# 상대 KB 경로는 저장소 루트 기준으로 해석하고 실제 작업 디렉터리로 사용한다.
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

# 인증·세션은 장비별 비공개 경로에 두고, 공용 설정 파일만 링크한다.
# 이미 다른 설정 파일이나 링크가 있으면 덮어쓰지 않고 중단한다.
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
# 패키지 관리 명령은 Pi CLI에 전달하고 대화형 관리 세션은 시작하지 않는다.
case "${1:-}" in
    install|remove|uninstall|update|list|config)
        exec "$PI_BINARY" "$@"
        ;;
esac
# 임의 도구·확장·세션 파일 인자로 관리 역할 경계를 바꾸지 못하게 검사한다.
node "$PI_CONFIG_ROOT/bin/manager-options.mjs" "$@"

# 자동 발견을 끄고 검토된 관리 확장만 로드한다.
# 재시작 요청 파일이 생기면 같은 실행 옵션과 최근 세션으로 다시 실행한다.
restart_args=()
while true; do
    pi_args=(
        --no-extensions --no-skills --no-prompt-templates --no-context-files
        --extension "$PI_CONFIG_ROOT/extensions/manager.ts"
    )
    if $managed; then
        managed_name="$(tmux display-message -p '#S')"
        [[ "$managed_name" =~ ^s8-[A-Za-z0-9_-]{1,40}$ ]] || { echo '관리 세션에서만 실행할 수 있습니다.' >&2; exit 2; }
        pi_args+=(--session-dir "$PI_CODING_AGENT_DIR/managed/$managed_name" --extension "$PI_CONFIG_ROOT/extensions/managed-session.mjs")
    elif [[ -n "$TELEGRAM_EXTENSION" ]]; then
        pi_args+=(--extension "$TELEGRAM_EXTENSION")
    fi
    pi_args+=(
        --system-prompt "$AGENT_ROOT/agents/manager/SYSTEM.md"
        --tools projectman,kb,scheduler
    )
    pi_args+=(${restart_args[@]+"${restart_args[@]}"})
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

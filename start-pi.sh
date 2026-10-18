#!/usr/bin/env bash
# project: Projectman 관리·개발 위임 / local: 프로젝트 서비스 없는 범용 에이전트.
# 사용 예: ./start-pi.sh / ./start-pi.sh --continue / ./start-pi.sh --session manager
# Telegram은 시작 메뉴에서 유지/가져오기를 선택한다. --telegram take/off로 명시할 수 있다.
# 루트 .env의 연결 설정을 자식 프로세스에 전달하며 인증 값은 출력하지 않는다.
# 모델 인증·대화는 .pi-runtime에 보관한다. 처음 실행하면 Pi에서 /login을 수행한다.
# 매니저·공유 서비스는 런타임 창에, 개발 Pi 워커는 전용 공유 tmux 세션에 유지한다. --no-scheduler / --no-supervisor로 자동 시작을 제외한다.
# 제외 옵션은 이미 실행 중인 공유 서비스를 종료하지 않는다.
set -euo pipefail

# 현재 터미널 위치와 관계없이 스크립트가 있는 저장소를 기준으로 경로를 계산한다.
AGENT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# 서비스 전용 진입점: 통합 실행의 tmux 자식과 수동 진단이 같은 경로를 사용한다.
if [[ "${1:-}" == --service ]]; then
    service="${2:-}"
    case "$service" in scheduler|supervisor|worker) ;; *) echo '서비스는 scheduler, supervisor 또는 worker여야 합니다.' >&2; exit 2 ;; esac
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
    if [[ "$service" == worker ]]; then exec node "$AGENT_ROOT/pi/bin/developer.mjs" "$@"; fi
    exec node "$AGENT_ROOT/pi/bin/$service.mjs" "$@"
fi
# 서비스 제어 옵션은 Pi에 넘기지 않고 여기서 소비한다. 옵션 위치와 관계없이 처리한다.
service_options=()
manager_options=()
telegram=auto
mode=""
local_cwd="$PWD"
profile_options=()
while (($#)); do
    case "$1" in
        --mode|--cwd)
            [[ $# -ge 2 && -n "$2" ]] || { echo "$1 값이 필요합니다." >&2; exit 2; }
            if [[ "$1" == --mode ]]; then mode="$2"; else local_cwd="$2"; fi
            shift 2 ;;
        --manager) mode=project; shift ;;
        --telegram)
            telegram=true
            case "${2:-}" in
                take) shift ;;
                off) telegram=false; shift ;;
                '') ;;
                --*) ;;
                *) echo '--telegram은 take 또는 off를 받습니다.' >&2; exit 2 ;;
            esac
            shift ;;
        --no-telegram) telegram=false; shift ;;
        *) profile_options+=("$1"); shift ;;
    esac
done
for option in ${profile_options[@]+"${profile_options[@]}"}; do
    case "$option" in
        --telegram) telegram=true ;;
        --no-telegram) telegram=false ;;
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
        '사용법: ./start-pi.sh [--mode project|local] [--cwd 경로] [Pi 옵션]' \
        '  --mode project  Projectman 관리·개발 위임 (기존 실행)' \
        '  --mode local    로컬 범용 에이전트 (프로젝트 서비스 없음)' \
        '  --cwd 경로      로컬 작업 디렉터리 (기본: 실행 위치)' \
        '  모드 생략 시 터미널에서 선택, 자동화에서는 명시 필수'  \
        '  (인자 없음)      프로젝트 / 로컬 모드 선택' \
        '  --no-scheduler   스케줄러 자동 시작 제외' \
        '  --no-supervisor  개발 슈퍼바이저 자동 시작 제외' \
        '  --service 종류   scheduler, supervisor 또는 worker <workerId> 전경 실행' \
        '  --telegram take  이 세션으로 Telegram 연결 이전 (단독 --telegram도 호환)' \
        '  --telegram off   이 세션의 Telegram 연결 비활성 (--no-telegram도 호환)' \
        '  --no-telegram    Telegram 없이 단독 실행' \
        '  --manager        기본 매니저의 별칭 (일반 대화·파일·Bash·Projectman·KB·예약)' \
        '  --sessions       실행 중인 S8 tmux 세션 목록' \
        '  --session 이름   s8-이름 세션 생성·재시작 후 목록 출력 (자동 접속 없음)' \
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
if [[ -z "$mode" ]]; then
    case "${1:-}" in
        install|remove|uninstall|update|list|config|--version) mode=local ;;
        *)
            if [[ ! -t 0 ]]; then echo '--mode project 또는 --mode local을 지정하세요.' >&2; exit 2; fi
            printf '%s\n' '실행 모드: 1) Projectman 프로젝트 관리·개발  2) 로컬 범용 에이전트'
            read -r -p '선택 [1/2]: ' selection
            case "$selection" in 1|project) mode=project ;; 2|local) mode=local ;; *) echo '잘못된 모드 선택입니다.' >&2; exit 2 ;; esac ;;
    esac
fi
case "$mode" in project|local) ;; *) echo '모드는 project 또는 local이어야 합니다.' >&2; exit 2 ;; esac
if [[ "$telegram" == auto && -t 0 && "${1:-}" != --managed ]]; then
    case "${1:-}" in
        install|remove|uninstall|update|list|config|--version|--print) ;;
        *)
            current_telegram="$(node "$AGENT_ROOT/pi/bin/telegram-status.mjs")"
            printf 'Telegram 현재 연결: %s\n' "$current_telegram"
            printf '%s\n' '1) 현재 연결 유지  2) 여기로 가져오기'
            read -r -p '선택 [1]: ' selection
            case "$selection" in ''|1) telegram=keep ;; 2|take) telegram=true ;; *) echo '잘못된 Telegram 선택입니다.' >&2; exit 2 ;; esac ;;
    esac
fi
local_cwd="$(cd -- "$local_cwd" && pwd -P)"
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
        telegram_options=()
        case "$telegram" in
            true) telegram_options=(--telegram take) ;;
            false) telegram_options=(--telegram off) ;;
            keep) telegram_options=(--telegram-keep) ;;
        esac
        exec node "$AGENT_ROOT/pi/bin/pi-runtime.mjs" --mode "$mode" --cwd "$local_cwd" ${telegram_options[@]+"${telegram_options[@]}"} ${service_options[@]+"${service_options[@]}"} "$@"
    fi
fi
if [[ "$telegram" == auto ]]; then
    telegram=false
    [[ "$mode" != project ]] || telegram=true
fi
# 연결·KB 경로 설정을 로드한다. 내용이나 인증 값을 로그로 출력하지 않는다.
if [[ "$mode" == project || "$telegram" == true || "$managed" == true ]]; then
    [ ! -f "$AGENT_ROOT/.env" ] || { set -a; source "$AGENT_ROOT/.env"; set +a; }
fi
if [[ "${1:-}" == telegram ]]; then
    printf '%s\n' 'telegram 단독 실행은 지원하지 않습니다. 인자 없이 ./start-pi.sh를 실행하세요.' >&2
    exit 2
fi
# 상대 KB 경로는 저장소 루트 기준으로 해석하고 실제 작업 디렉터리로 사용한다.
KNOWLEDGE_BASE_ROOT="$local_cwd"
if [[ "$mode" == project ]]; then KNOWLEDGE_BASE_ROOT="${S8_KB_ROOT:-$AGENT_ROOT/../854_md}"; fi
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
stop_pi() {
    trap - INT TERM HUP
    if [[ -n "${pi_pid:-}" ]]; then
        kill -TERM "$pi_pid" 2>/dev/null || true
        wait "$pi_pid" 2>/dev/null || true
    fi
    exit 0
}
trap stop_pi INT TERM HUP
while true; do
    if $managed; then
        telegram=false
        [[ "$(tmux show-option -qv @s8-telegram)" != take ]] || telegram=true
    fi
    pi_args=(
        --no-extensions --no-skills --no-prompt-templates --no-context-files
        --extension "$PI_CONFIG_ROOT/extensions/$([[ "$mode" == project ]] && echo manager.ts || echo local.mjs)"
    )
    if $managed; then
        managed_name="$(tmux display-message -p '#S')"
        [[ "$managed_name" =~ ^s8-[A-Za-z0-9_-]{1,40}$ ]] || { echo '관리 세션에서만 실행할 수 있습니다.' >&2; exit 2; }
        session_path="$PI_CODING_AGENT_DIR/managed/$managed_name"
        if [[ "$mode" == local ]]; then
            cwd_key="$(printf '%s' "$KNOWLEDGE_BASE_ROOT" | sha256sum | cut -c1-16)"
            session_path="$PI_CODING_AGENT_DIR/local/$managed_name/$cwd_key"
        fi
        pi_args+=(--session-dir "$session_path")
        pi_args+=(--extension "$PI_CONFIG_ROOT/extensions/managed-session.mjs")
    elif $telegram; then
        pi_args+=(--extension "$PI_CONFIG_ROOT/extensions/telegram.mjs")
    fi
    if [[ "$mode" == project ]]; then
        pi_args+=(--system-prompt "$AGENT_ROOT/agents/manager/SYSTEM.md" --tools projectman,kb,scheduler,read,bash,edit,write,grep,find,ls)
    else
        pi_args+=(--system-prompt "$AGENT_ROOT/agents/local/SYSTEM.md" --tools read,bash,edit,write,grep,find,ls)
    fi
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

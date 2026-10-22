#!/usr/bin/env bash
set -euo pipefail

AGENT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
SESSION='s8-infra'
cd "$AGENT_ROOT"

command -v tmux >/dev/null 2>&1 || {
    printf '%s\n' '오류: tmux가 설치되어 있지 않습니다.' >&2
    exit 1
}

# 설정은 s8-config.yml에서 읽는다. 라우터·KB Browser·frontend 개발 서버에는 비밀값 없는 환경변수로 넘긴다.
settings_env="$(node pi/bin/s8-config.mjs shell-env)"
eval "$settings_env"
phcms_start_command="$(node pi/bin/s8-config.mjs start-command)"

# 리눅스는 일반 사용자에게 1024 미만 포트를 막는다(macOS는 제한 없음). 라우터가 열 수 없으면 허용 방법을 안내하고 멈춘다.
unprivileged_port_file='/proc/sys/net/ipv4/ip_unprivileged_port_start'
if [[ "$(uname -s)" == Linux && "$EUID" -ne 0 && -r "$unprivileged_port_file" ]] \
    && (( S8_HTTP_PORT < $(<"$unprivileged_port_file") )); then
    {
        printf '오류: 라우터가 %s번 포트를 열 수 없습니다. 이 장비는 %s번 미만 포트를 일반 사용자에게 허용하지 않습니다.\n' \
            "$S8_HTTP_PORT" "$(<"$unprivileged_port_file")"
        printf '%s\n' '아래 명령으로 한 번 허용한 뒤 다시 실행하세요(재부팅 후에도 유지):'
        printf "  echo 'net.ipv4.ip_unprivileged_port_start=%s' | sudo tee /etc/sysctl.d/90-s8-router-port.conf\n" "$S8_HTTP_PORT"
        printf '%s\n' '  sudo sysctl --system'
    } >&2
    exit 1
fi

if [[ ! -d apps/kb-browser/node_modules ]]; then
    printf '%s\n' '오류: KB Browser 의존성이 없습니다: npm ci --prefix apps/kb-browser' >&2
    exit 1
fi

if tmux has-session -t "=$SESSION" 2>/dev/null; then
    while IFS= read -r pane; do
        tmux send-keys -t "$pane" C-c
    done < <(tmux list-panes -s -t "=$SESSION" -F '#{pane_id}')
    sleep 1
    tmux kill-session -t "=$SESSION"
fi

tmux new-session -d -s "$SESSION" -n router -c "$AGENT_ROOT"
tmux new-window -d -t "=$SESSION:" -n phcms -c "$AGENT_ROOT"
tmux new-window -d -t "=$SESSION:" -n kb-browser -c "$AGENT_ROOT"
tmux new-window -d -t "=$SESSION:" -n frontend -c "$AGENT_ROOT"
tmux new-window -d -t "=$SESSION:" -n projectman-console -c "$AGENT_ROOT"
tmux new-window -d -t "=$SESSION:" -n terminal-gateway -c "$AGENT_ROOT"
tmux new-window -d -t "=$SESSION:" -n comm-center -c "$AGENT_ROOT"

# router 창: 공개 주소를 받아 경로별로 로컬 서비스에 전달. kb-browser 창: 지식베이스 API(localhost 전용).
mkdir -p .s8-runtime/data/uploads
tmux send-keys -t "=$SESSION:router" \
    'eval "$(node pi/bin/s8-config.mjs shell-env)"; node infra/router/router.mjs' C-m
tmux send-keys -t "=$SESSION:kb-browser" \
    'eval "$(node pi/bin/s8-config.mjs shell-env)"; npm run build --prefix apps/kb-browser && KB_ROOT="$S8_KB_ROOT" UPLOAD_DIR="$PWD/.s8-runtime/data/uploads" HOST=127.0.0.1 PORT=8787 npm start --prefix apps/kb-browser' C-m
if [[ -n "$phcms_start_command" ]]; then
    tmux send-keys -t "=$SESSION:phcms" -l "$phcms_start_command"
    tmux send-keys -t "=$SESSION:phcms" C-m
fi
tmux send-keys -t "=$SESSION:projectman-console" \
    'node pi/bin/projectman-console.mjs' C-m
tmux send-keys -t "=$SESSION:terminal-gateway" \
    'npm start --prefix apps/terminal-gateway' C-m
# comm-center 창: 에이전트 통신 중계. 설정(apps/comm-center/.env)이 있는 장비에서만 실행한다.
comm_center_ready=false
if [[ -f apps/comm-center/.env && -d apps/comm-center/node_modules ]]; then
    comm_center_ready=true
    tmux send-keys -t "=$SESSION:comm-center" 'npm start --prefix apps/comm-center' C-m
fi
tmux send-keys -t "=$SESSION:frontend" \
    'eval "$(node pi/bin/s8-config.mjs shell-env)"; npm run dev --prefix frontend -- --host 127.0.0.1 --port 4178 --strictPort' C-m

printf '%s\n' "tmux 세션을 새로 시작했습니다: $SESSION"
if [[ -n "$phcms_start_command" ]]; then
    printf '%s\n' 's8-config.yml의 projectman.startCommand를 phcms 창에서 실행했습니다.'
else
    printf '%s\n' 's8-config.yml에 projectman.startCommand가 없어 phcms 창은 비워 두었습니다.'
fi
if [[ "$comm_center_ready" == true ]]; then
    printf '%s\n' 'comm-center 창에서 에이전트 통신 중계를 시작했습니다.'
else
    printf '%s\n' 'apps/comm-center/.env 또는 의존성이 없어 comm-center 창은 비워 두었습니다(통신을 쓰지 않으면 무시).'
fi
printf '웹 터미널의 세션 목록에서 %s 을 선택하세요.\n' "$SESSION"

#!/usr/bin/env bash
set -euo pipefail

AGENT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
SESSION='s8-infra'
cd "$AGENT_ROOT"

command -v tmux >/dev/null 2>&1 || {
    printf '%s\n' '오류: tmux가 설치되어 있지 않습니다.' >&2
    exit 1
}
command -v docker >/dev/null 2>&1 || {
    printf '%s\n' '오류: Docker가 설치되어 있지 않습니다.' >&2
    exit 1
}

if ! tmux has-session -t "=$SESSION" 2>/dev/null; then
    tmux new-session -d -s "$SESSION" -n nginx -c "$AGENT_ROOT" || {
        tmux has-session -t "=$SESSION" 2>/dev/null || exit 1
    }
fi

ensure_window() {
    local name="$1"
    local windows
    windows="$(tmux list-windows -t "=$SESSION" -F '#W')"
    if printf '%s\n' "$windows" | grep -Fqx -- "$name"; then
        WINDOW_CREATED=false
    else
        tmux new-window -d -t "=$SESSION:" -n "$name" -c "$AGENT_ROOT"
        WINDOW_CREATED=true
    fi
}

ensure_window nginx
nginx_created="$WINDOW_CREATED"
ensure_window phcms
ensure_window kb-browser
kb_browser_created="$WINDOW_CREATED"
ensure_window frontend
frontend_created="$WINDOW_CREATED"

compose_file='infra/nginx/docker-compose.yml'
running_services="$(docker compose -f "$compose_file" ps --status running --services)"
if printf '%s\n' "$running_services" | grep -Fqx nginx &&
   printf '%s\n' "$running_services" | grep -Fqx kb-browser; then
    printf '%s\n' 'Nginx와 KB Browser가 이미 실행 중입니다. 기존 컨테이너를 유지합니다.'
else
    docker compose -f "$compose_file" up --build -d
fi

if $nginx_created; then
    tmux send-keys -t "=$SESSION:nginx" \
        "docker compose -f $compose_file logs --follow nginx" C-m
fi
if $kb_browser_created; then
    tmux send-keys -t "=$SESSION:kb-browser" \
        "docker compose -f $compose_file logs --follow kb-browser" C-m
fi
if $frontend_created; then
    if curl --silent --show-error --fail --max-time 2 \
        --output /dev/null http://127.0.0.1:4178/s8/ 2>/dev/null; then
        tmux send-keys -t "=$SESSION:frontend" \
            'printf "%s\n" "frontend가 이미 127.0.0.1:4178에서 응답 중입니다. 기존 서버를 유지합니다."' C-m
    else
        tmux send-keys -t "=$SESSION:frontend" \
            'npm run dev --prefix frontend -- --host 127.0.0.1 --port 4178 --strictPort' C-m
    fi
fi

printf '%s\n' \
    "tmux 세션을 준비했습니다: $SESSION" \
    '기존 창과 실행 중인 서비스는 유지하고, 없는 창과 서비스를 준비했습니다.' \
    'phcms 창은 비워 두었습니다.' \
    "웹 터미널의 세션 목록에서 $SESSION 을 선택하세요."

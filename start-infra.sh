#!/usr/bin/env bash
set -euo pipefail

AGENT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
SESSION='s8-infra'

command -v tmux >/dev/null 2>&1 || {
    printf '%s\n' '오류: tmux가 설치되어 있지 않습니다.' >&2
    exit 1
}

if tmux has-session -t "=$SESSION" 2>/dev/null; then
    printf '기존 %s 세션을 유지합니다.\n' "$SESSION"
    tmux list-windows -t "=$SESSION" -F '#{window_index}: #{window_name}'
    exit 0
fi

tmux new-session -d -s "$SESSION" -n nginx -c "$AGENT_ROOT"
tmux new-window -d -t "=$SESSION" -n phcms -c "$AGENT_ROOT"
tmux new-window -d -t "=$SESSION" -n kb-browser -c "$AGENT_ROOT"
tmux new-window -d -t "=$SESSION" -n frontend -c "$AGENT_ROOT"

tmux send-keys -t "=$SESSION:nginx" \
    'docker compose -f infra/nginx/docker-compose.yml up --build -d && tmux send-keys -t "=s8-infra:kb-browser" "docker compose -f infra/nginx/docker-compose.yml logs --follow kb-browser" C-m && docker compose -f infra/nginx/docker-compose.yml logs --follow nginx' C-m
tmux send-keys -t "=$SESSION:frontend" \
    'npm run dev --prefix frontend -- --host 127.0.0.1 --port 4178' C-m

printf '%s\n' \
    "tmux 세션을 시작했습니다: $SESSION" \
    '창: nginx, phcms (비어 있음), kb-browser, frontend' \
    "웹 터미널의 세션 목록에서 $SESSION 을 선택하세요."

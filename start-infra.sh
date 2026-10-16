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

if tmux has-session -t "=$SESSION" 2>/dev/null; then
    while IFS= read -r pane; do
        tmux send-keys -t "$pane" C-c
    done < <(tmux list-panes -s -t "=$SESSION" -F '#{pane_id}')
    sleep 1
    tmux kill-session -t "=$SESSION"
fi

tmux new-session -d -s "$SESSION" -n nginx -c "$AGENT_ROOT"
tmux new-window -d -t "=$SESSION:" -n phcms -c "$AGENT_ROOT"
tmux new-window -d -t "=$SESSION:" -n kb-browser -c "$AGENT_ROOT"
tmux new-window -d -t "=$SESSION:" -n frontend -c "$AGENT_ROOT"

compose_file='infra/nginx/docker-compose.yml'
compose=(docker compose)
if [[ -f "$AGENT_ROOT/.env" ]]; then
    compose+=(--env-file "$AGENT_ROOT/.env")
fi
phcms_start_command="${PHCMS_START_COMMAND:-}"
if [[ -f "$AGENT_ROOT/.env" ]]; then
    phcms_start_command="$(node --env-file="$AGENT_ROOT/.env" \
        -e 'process.stdout.write(process.env.PHCMS_START_COMMAND ?? "")')"
fi
"${compose[@]}" -f "$compose_file" up --build --force-recreate -d

nginx_logs_command="$(printf '%q ' "${compose[@]}" -f "$compose_file" logs --follow nginx)"
tmux send-keys -t "=$SESSION:nginx" "$nginx_logs_command" C-m
kb_browser_logs_command="$(printf '%q ' "${compose[@]}" -f "$compose_file" logs --follow kb-browser)"
tmux send-keys -t "=$SESSION:kb-browser" "$kb_browser_logs_command" C-m
if [[ -n "$phcms_start_command" ]]; then
    tmux send-keys -t "=$SESSION:phcms" -l "$phcms_start_command"
    tmux send-keys -t "=$SESSION:phcms" C-m
fi
tmux send-keys -t "=$SESSION:frontend" \
    'npm run dev --prefix frontend -- --host 127.0.0.1 --port 4178 --strictPort' C-m

printf '%s\n' \
    "tmux 세션을 새로 시작했습니다: $SESSION" \
    '기존 세션 창과 인프라 컨테이너를 교체했습니다.'
if [[ -n "$phcms_start_command" ]]; then
    printf '%s\n' 'PHCMS_START_COMMAND를 phcms 창에서 실행했습니다.'
else
    printf '%s\n' 'PHCMS_START_COMMAND가 없어 phcms 창은 비워 두었습니다.'
fi
printf '웹 터미널의 세션 목록에서 %s 을 선택하세요.\n' "$SESSION"

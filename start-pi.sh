#!/usr/bin/env bash
# S8 실행 진입점. Linux·macOS 전용이며 실제 처리는 pi/bin/start.mjs가 맡는다.
#   ./start-pi.sh                         모드·Telegram 선택 후 tmux 런타임 시작
#   ./start-pi.sh --mode project|local    모드 지정 (--help로 전체 옵션 확인)
#   ./start-pi.sh --service 종류          scheduler, supervisor 또는 worker <workerId> 전경 실행
# tmux 서비스 창·원격 워커(ssh-worker.mjs)·문서가 이 경로를 사용하므로 위치와 이름을 유지한다.
set -euo pipefail
exec node "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/pi/bin/start.mjs" "$@"

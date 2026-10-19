#!/usr/bin/env bash
# S8 운영 진입점: tmux 런타임(매니저·범용 Pi 창)과 공유 서비스(scheduler, supervisor, 개발 워커). Linux·macOS 전용.
#   ./s8.sh                    모드·Telegram 선택 후 tmux 런타임 (재)시작 (--help로 전체 옵션 확인)
#   ./s8.sh --sessions         실행 중인 S8 tmux 세션 목록
#   ./s8.sh service 종류       scheduler, supervisor 또는 worker <workerId> 전경 실행
# 에이전트 하나만 실행하려면 ./start-pi.sh를 사용한다.
set -euo pipefail
exec node "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/pi/bin/s8.mjs" "$@"

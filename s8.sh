#!/usr/bin/env bash
# S8 운영 진입점: tmux 런타임(매니저·범용 Pi 창), 예약 데몬, 작업 워커 실행. Linux·macOS 전용.
#   ./s8.sh                    모드·Telegram 선택 후 tmux 런타임 (재)시작 (--help로 전체 옵션 확인)
#   ./s8.sh --sessions         실행 중인 S8 tmux 세션 목록
#   ./s8.sh work UID           승인된 작업의 워커를 s8-workers 세션 창에 실행
#   ./s8.sh finish UID --run-id UUID --confirm-stopped   멈춘 실행을 실패로 마무리
#   ./s8.sh service scheduler  예약 데몬 전경 실행
# 에이전트 하나만 실행하려면 ./start-general-agent.sh, ./start-manager-agent.sh, ./start-worker-agent.sh를 사용한다.
set -euo pipefail
exec node "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/pi/bin/s8.mjs" "$@"

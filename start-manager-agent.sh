#!/usr/bin/env bash
# Projectman 매니저 에이전트를 이 터미널에서 실행한다. KB 저장소에서 프로젝트·작업을 만들고 워커 보고를 받는다.
#   ./start-manager-agent.sh               매니저 실행
#   ./start-manager-agent.sh --telegram    Telegram 연결
#   ./start-manager-agent.sh --help        전체 옵션
# Linux·macOS 전용, 실제 처리는 pi/bin/agent.mjs. tmux 런타임·서비스는 ./s8.sh가 담당한다.
set -euo pipefail
exec node "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/pi/bin/agent.mjs" manager "$@"

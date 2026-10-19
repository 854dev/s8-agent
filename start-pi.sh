#!/usr/bin/env bash
# S8 에이전트 실행기: 에이전트 하나를 이 터미널에서 실행한다. Linux·macOS 전용, 실제 처리는 pi/bin/agent.mjs.
#   ./start-pi.sh                      범용 에이전트 (실행 위치에서 파일·셸·코드 작업)
#   ./start-pi.sh --mode manager       Projectman 매니저
#   ./start-pi.sh --mode worker --uid UID   Projectman 워커 (실행 위치에서 UID 작업 claim·수행·보고)
#   ./start-pi.sh --help               전체 옵션
# tmux 런타임·서비스는 ./s8.sh가 담당한다.
set -euo pipefail
exec node "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/pi/bin/agent.mjs" "$@"

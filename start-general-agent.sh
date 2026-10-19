#!/usr/bin/env bash
# 범용 에이전트를 이 터미널에서 실행한다. Projectman 없이 실행 위치에서 파일·셸·코드 작업을 한다.
#   ./start-general-agent.sh                 실행 위치에서 작업
#   ./start-general-agent.sh --cwd 경로      지정한 위치에서 작업
#   ./start-general-agent.sh install 패키지  Pi 패키지 명령(모든 에이전트가 공유)
#   ./start-general-agent.sh --help          전체 옵션
# Linux·macOS 전용, 실제 처리는 pi/bin/agent.mjs. tmux 런타임은 ./s8.sh --mode general을 사용한다.
set -euo pipefail
exec node "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/pi/bin/agent.mjs" general "$@"

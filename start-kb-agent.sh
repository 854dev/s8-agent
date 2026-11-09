#!/usr/bin/env bash
# KB 구축 전문 에이전트. 기본 작업 위치는 config.yml의 kbAgent.harnessRoot다.
#   ./start-kb-agent.sh                         매뉴얼 디렉터리에서 실행
#   ./start-kb-agent.sh --cwd /path/to/customer 고객 작업 디렉터리에서 실행
#   ./start-kb-agent.sh --help                  전체 옵션
set -euo pipefail
exec node "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/pi/bin/agent.mjs" kb "$@"

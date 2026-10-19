#!/usr/bin/env bash
# Projectman 워커 에이전트를 이 터미널에서 실행한다. 실행 위치 저장소에서 UID 작업을 직접 claim·수행·보고한다.
#   ./start-worker-agent.sh --uid UID              바로 UID 작업 시작
#   ./start-worker-agent.sh --uid UID --cwd 경로   지정한 저장소에서 작업
#   ./start-worker-agent.sh --help                 전체 옵션
# Linux·macOS 전용, 실제 처리는 pi/bin/agent.mjs. worktree 준비까지 맡기려면 ./s8.sh work UID를 사용한다.
set -euo pipefail
exec node "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/pi/bin/agent.mjs" worker "$@"

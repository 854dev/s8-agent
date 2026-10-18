# 원격 워커 구현 handoff

작성일: 2026-10-19. 이 문서는 quota 종료 시점의 코드 상태와 다음 작업을 이어받기 위한 기록이다.

## 현재 상태

로컬·원격 워커 공통 구조의 주요 코드 경로가 구현되어 있다. `worker-entries`가 worker ID와 실행 방식을 결정하고, 로컬 Pi 워커와 원격 워커는 인증된 HTTP long-poll 통신기를 통해 등록·배정·상태 보고·명령 확인을 한다. 통신기 메시지는 파일로 보존되고, 작업 패치·결과·이벤트는 run별 artifact 경로로 전송된다. 저장소별 원격 경로 매핑, managed SSH/tmux 기동과 drain, Claude Code CLI 어댑터가 추가되어 있다. 기존 supervisor의 승인·claim·report outbox·매니저 inbox·Telegram 알림 흐름은 유지한다.

핵심 구현 위치:

- `pi/lib/development/worker-communicator.mjs`: worker별 인증, 상태·메시지 큐, long polling, 입력/결과 artifact 전송
- `pi/lib/development/worker-daemon.mjs`, `worker-pool.mjs`, `supervisor.mjs`: 공통 연결, UID 배정, 보고와 복구
- `pi/lib/development/worker-workspace.mjs`, `workspace.mjs`: 장치별 checkout 매핑과 패치·산출물 처리
- `pi/lib/development/ssh-worker.mjs`: managed 원격 tmux 수명 관리
- `pi/lib/development/worker-session-claude.mjs`: UID마다 격리된 Claude Code print 세션 실행
- `pi/lib/config/s8-config.mjs`, `pi/bin/s8-config.mjs`, `s8-config.example.yml`: 명시적 워커 설정과 count 마이그레이션
- `docs/remote-worker-implementation-plan.md`: 설계, 계약, 수용 기준

Claude 워커는 사용자가 이미 열어 둔 TUI에 입력을 삽입하지 않는다. 워커 런타임이 UID별 전용 Claude Code 세션을 시작한다. external 워커는 자동 기동하지 않으며 같은 daemon/protocol을 별도로 실행해야 한다.

PH-CMS 소스와 DB 스키마는 변경하지 않았다. `.env.example`에는 Claude 워커용 `PHCMS_MCP_URL` 자리표시자만 추가되어 있다. 실제 `.env`를 읽거나 비밀 값을 handoff에 기록하지 않았다. 실제 Projectman MCP 접속과 두 장치 간 전송은 아직 실장치에서 확인하지 않았다.

## 검증 기록

2026-10-19 실행 결과:

```bash
node --test pi/test/worker-communicator.test.mjs pi/test/worker-pool.test.mjs pi/test/worker-pool-lifecycle.test.mjs pi/test/remote-worker-workspace.test.mjs pi/test/worker-session-claude.test.mjs pi/test/ssh-worker.test.mjs pi/test/development-supervisor.test.mjs pi/test/telegram-config.test.mjs
```

30개 통과, 0개 실패. 첫 실행에서 설정 회귀 픽스처에 managed SSH 항목의 필수 `root`가 없어 실패했고, 픽스처를 보완한 뒤 전체 묶음을 다시 통과시켰다. `git diff --check`도 통과했다. 이 검증은 관련 하위집합이며 전체 저장소 테스트, frontend 테스트/build, PH-CMS 회귀 통합은 아직 실행하지 않았다.

2026-10-19 전체 검증(같은 날 이어서):

```bash
node --test pi/test/*.test.mjs apps/telegram-gateway/gateway.test.mjs
npm run test:run --prefix frontend
npm run build --prefix frontend
bash pi/bin/test-projectman-worker-pool.sh ../ph-cms
git diff --check
```

- Node 회귀 154개 통과, 0개 실패.
- 프런트엔드 57개 통과, `tsc -b && vite build` 성공.
- PH-CMS 통합 1개 통과(`ok:true`, `browserApproval:true`, `linkLoginPreserved:true`). PH-CMS 파일은 변경되지 않았다(`git -C ../ph-cms status --short` 비어 있음).
- `git diff --check` 통과.
- `s8-config.example.yml`, README·계획의 worker 예시 YAML, `s8-config.mjs show`를 실제 설정 검증기로 대조해 통과시켰다.

전체 회귀 첫 실행에서 10개가 실패했고 모두 이번 변경이 만든 회귀였다(baseline HEAD 19개는 통과). 수정한 두 곳:

1. `pi/lib/development/worker-pool.mjs`: deferred 반환의 `count`가 설정 항목 수 대신 현재 실행 중인 워커 창 수(`current.length`)를 반환하도록 되돌렸다(`pi-services` 기대값과 기존 동작 일치).
2. `pi/test/pi-runtime.test.mjs`: fixture가 새 `worker-pool.mjs`의 전이 의존성(`worker-communicator.mjs`, `ssh-worker.mjs`, `storage/json-file.mjs`, `scheduler/control.mjs`, `scheduler/store.mjs`, `apps/telegram-gateway/gateway.mjs`)을 복사하지 않아 런타임 컨트롤러가 `ERR_MODULE_NOT_FOUND`로 죽고 타임아웃했다. fixture 복사 목록을 보완했다.

## 다음 작업

1. ~~문서·설정 예시를 다시 대조한다.~~ 완료. README·계획 예시, `s8-config.example.yml`, `s8-config.mjs show`가 실제 설정 검증 규칙을 만족함을 확인했다.
2. ~~전체 Node 회귀와 frontend 테스트/build를 실행하고 실패를 수정한다. 그 다음 `bash pi/bin/test-projectman-worker-pool.sh ../ph-cms` 경로로 전체 연동을 확인한다.~~ 완료. 회귀 2건을 수정하고 Node 154·프런트엔드 57+build·PH-CMS 통합 1을 통과시켰다.
3. 두 장치를 준비한다. 중앙 장치의 communicator를 Tailscale IPv4에 바인딩하고, 원격 장치가 접근할 수 있는 Projectman MCP URL, Claude Code CLI 인증, Git checkout과 빌드 도구, SSH 계정을 준비한다. `.env`의 실제 값을 문서나 로그에 복사하지 않는다.
4. worker별 통신 토큰을 중앙의 `.s8-runtime/worker-auth/<workerId>.token`에서 안전한 별도 채널로 전달한다. 토큰 값은 명령 인자·로그·Git에 넣지 않는다. 중앙 `repository-mappings`와 원격 `root`를 실제 절대 경로로 맞춘다.
5. 로컬 Pi 1개와 managed 원격 Claude 1개로 승인된 테스트 work 하나를 실행한다. UID 조회, 원격 입력 패치 적용, 완료 보고, task/changes patch 회수, Projectman review, 매니저 inbox, Telegram 링크, 화면의 사람 검토 후 done까지 확인한다.
6. 연결 단절·daemon 재시작·중복 메시지·취소·worker 설정 변경을 점검한다. run 상태가 불명확할 때 중복 실행하지 않고 결과/artifact가 보존되는지 확인한다. 원격 산출물 손상·업로드 중단 처리도 여기서 실장치로 확인한다.
7. 구현 계획 체크리스트는 증거가 확인된 자동 검증 항목만 완료로 표시했다. README 운영 안내 최종화는 실장치 항목(3~6)이 끝난 뒤 수행한다.

## 이어받을 때 주의

- 작업 트리의 변경은 아직 커밋되지 않았다. 재개 시 `git status --short`와 diff를 먼저 확인하고 기존 변경을 보존한다.
- 승인된 work의 담당자 ID를 자동 변경하거나, 실패 work를 자동 재실행하지 않는다.
- 원격 장치가 아직 준비되지 않아도 로컬 경로의 코드 테스트와 문서 정리는 계속할 수 있다. 실장치 수용 기준은 장치 연결 없이 완료 처리하지 않는다.

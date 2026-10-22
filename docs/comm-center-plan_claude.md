# comm-center 전환 작업계획

- 작성: Claude
- 작성일: 2026-10-22
- 기준 커밋: `a144b79` (edit : 통신 기능 간소화)
- 상태: 1~4단계 구현 완료(브랜치 `comm-center`, 미커밋). 남은 작업은 맨 아래 "남은 작업".

## 결정 사항 (2026-10-22)

- 통신 구조는 comm-center로 확정한다. 이전 검토 문서(`manager-worker-decoupling*`)는 모두 삭제했다.
- 기본 포트는 8090을 유지한다. 현재 운영 장비에서는 s8 general만 실행 중이고 communicator를 띄우지 않으므로 충돌이 없다.
- 작업은 실행 중인 s8과 분리하려고 git worktree `/home/sangbong/s8-agent-wip/comm-center`(브랜치 `comm-center`)에서 한다.

### 구현 중 바꾼 결정

- **Projectman claim의 `workerId`는 통신 정체성과 묶지 않는다.** 원래 2단계 계획은 `welcome.agentId`를 claim에 쓰는 것이었다. 하지만 그러면 claim 주체가 연결 시점에 따라 달라진다. 그래서 claim은 지금처럼 `S8_WORKER_ID` 또는 `s8-developer`를 쓴다.
- **워커는 `to`를 생략할 수 있다.** 그러면 comm-center가 등록된 매니저(정확히 하나일 때)에게 보낸다. 워커가 매니저 ID를 알 필요가 없다.
- **세션별 토큰은 `S8_COMM_TOKEN_FILE`로 지정한다.** 한 체크아웃에서 여러 세션을 동시에 쓸 때를 위한 것이다. 이전에는 `S8_WORKER_ID`가 인증 파일 안의 항목을 고르던 역할이다.
- **센터가 앱 수준 `ping` 프레임을 보낸다.** Node 내장 WebSocket은 프로토콜 ping을 보여 주지 않는다. 그래서 클라이언트는 45초 동안 아무 프레임도 받지 못하면 연결을 끊고 재접속한다.
- **토큰 파일을 읽지 못하면 세션을 실패시키지 않는다.** 경고를 표시하고 통신만 끈다.

## 목표

에이전트 간 통신을 Pi 밖의 독립 앱 `apps/comm-center`로 옮긴다. Pi에는 comm-center에 접속하는 얇은 확장 하나만 남긴다.

- 매니저와 워커는 똑같은 클라이언트다. 역할(`manager`, `worker`)은 comm-center의 등록부가 정한다.
- 각 장비가 알아야 하는 것은 comm-center 주소와 자기 토큰 파일 둘뿐이다.
- 통신 서버, 인증, 라우팅, 중복 방지, 제한, heartbeat는 comm-center가 맡는다.

## 구조

```text
지금
  매니저 Pi ─ Unix 소켓 ─ communicator(./s8.sh service communicator) ─ WebSocket ─ 워커 Pi

전환 후
  매니저 Pi ─┐
  워커 Pi  ──┼─ WebSocket ─ apps/comm-center (한 곳에서 실행)
  워커 Pi  ──┘
```

### Pi에 남는 것과 이유

에이전트가 쉬고 있을 때 받은 메시지를 세션에 넣고 새 턴을 시작하는 일은 Pi 프로세스 안에서만 할 수 있다. 이때 쓰는 `pi.sendMessage(..., { triggerTurn })`, `ctx.isIdle()`, 세션 기록 조회가 확장 API이기 때문이다. 그래서 다음 두 가지는 Pi에 남는다.

- `pi/extensions/communication.mjs`: `agent_message` 도구와 comm-center 연결의 수명 주기
- `pi/lib/communication/session.mjs`: 쉴 때 주입하고, 세션 기록에서 주입을 확인하면 `injected` 확인을 보냄

연결 클라이언트는 `apps/comm-center/client.mjs`를 그대로 가져다 쓴다. 이 파일은 Node 내장 `WebSocket`과 `node:crypto`만 쓰므로, 워커 장비에서 `apps/comm-center`의 의존성을 설치하지 않아도 된다.

## comm-center 프로토콜 v1 (1단계에서 구현)

모든 프레임은 JSON 텍스트이고 64KB를 넘지 않는다.

| 방향 | 프레임 | 설명 |
|---|---|---|
| 클라이언트 → 센터 | `hello {version, token}` | 연결 후 5초 안에 보낸다. 토큰은 헤더가 아니라 첫 프레임에 실는다 |
| 센터 → 클라이언트 | `welcome {agentId, role}` | 토큰 해시로 찾은 정체성. 클라이언트는 자기 ID를 설정에 따로 두지 않는다 |
| 클라이언트 → 센터 | `send {id, to?, type, text, replyTo?, groupId?}` | `type`은 `request`, `reply`, `notice`, `proposal`, `result`. `reply`에는 `replyTo`가 필요하다. 워커는 `to`를 생략하면 매니저에게 보낸다 |
| 센터 → 수신자 | `message {id, from, to, type, text, replyTo?, groupId?, sentAt}` | `from`은 센터가 인증된 정체성으로 채운다. 위조할 수 없다 |
| 수신자 → 센터 | `ack {for, from, state, reason?}` | `pending`, `injected`, `rejected`. 같은 메시지에 여러 번 보내 상태를 갱신할 수 있다 |
| 클라이언트 → 센터 | `status {id, messageId}` | 보낸 메시지의 최신 상태 |
| 클라이언트 → 센터 | `peers {id}` | 매니저만 쓸 수 있다. 등록된 에이전트와 연결 상태 |
| 센터 → 클라이언트 | `result {for, state, to?, reason?, peers?}` | `send`, `status`, `peers`에 대한 응답 |
| 센터 → 클라이언트 | `ping` | heartbeat 간격마다 보낸다. 클라이언트는 세 간격 동안 프레임이 없으면 재접속한다 |

전달 상태:

- `pending`: 수신 세션의 대기열에 들어감
- `injected`: 세션 기록에 추가됨
- `rejected`: 거부
- `unavailable`: 대상이 미접속이거나 없음
- `unknown`: 확인하지 못함(시간 초과, 연결 끊김)

어느 상태도 업무 완료를 뜻하지 않는다.

라우팅 규칙: 매니저는 워커에게, 워커는 매니저에게만 보낸다. 워커끼리는 보낼 수 없다.

종료 코드:

- `4000`: 버전 불일치
- `4001`: 인증 실패
- `4009`: 같은 ID가 이미 연결됨
- `1008`: 형식이나 정책 위반

클라이언트는 `4000`과 `4001`에서는 재접속하지 않는다.

제한: 본문 16,000자, 연결당 분당 600프레임, 발신자당 확인 대기 100건, 확인 대기 30초, 중복 방지 기록 5분, heartbeat 15초.

오프라인 보관과 재전송은 v1에 없다. 지금 구조와 같다. 필요해지면 comm-center에만 추가한다.

### 등록부와 토큰

- 센터 등록부 파일(`COMM_CENTER_AGENTS_FILE`, 권한 600): `{ "agents": { "<id>": { "role": "manager|worker", "tokenSha256": "<hex>" } } }`. 토큰 원문은 두지 않는다.
- 각 에이전트 토큰 파일(권한 600): `{ "token": "<원문>" }`.
- 발급: `npm run issue --prefix apps/comm-center -- <등록부> <id> <role> <토큰파일>`. 토큰 파일을 새로 만들고(덮어쓰지 않음) 등록부에 해시를 넣는다. 토큰을 화면에 출력하지 않는다.
- 등록부를 바꾸면 comm-center를 재시작해야 반영된다.

## 단계

### 1단계: comm-center 골격 (완료)

- `apps/comm-center/`: `protocol.mjs`, `registry.mjs`, `server.mjs`, `client.mjs`, `main.mjs`, `issue.mjs`, `server.test.mjs`, `package.json`, `.env.example`, `README.md`
- Pi 코드는 바꾸지 않는다. 기존 communicator와 함께 존재할 수 있다.
- 완료 확인: `npm test --prefix apps/comm-center` 통과.
- 결과(2026-10-22): 앱 수준 ping과 등록부 잠금을 추가해 17개 테스트 통과. 처음 골격은 12개였다. 다루는 범위는 정체성 부여와 왕복, 라우팅 거부, fan-out, 중복 전송 방지, 미확인·연결 끊김 시 `unknown`, 센터 재시작 후 재접속, 인증·버전·브라우저·중복 ID 거부, 발신자 위조와 남의 확인 차단, HTTP 경로 없음, 프레임 검증, 등록부 권한과 해시 저장. `main.mjs`의 설정 오류 처리와 시작·종료, `issue.mjs`의 덮어쓰기 거부도 직접 실행해 확인했다.

### 2단계: Pi 확장을 클라이언트로 교체 (완료)

- `pi/extensions/communication.mjs`를 `apps/comm-center/client.mjs` 기반으로 다시 쓴다. 매니저와 워커가 같은 경로를 쓴다.
  - `list` → `peers()`
  - `request`, `reply`, `notice`, `proposal`, `result` → `send()`. 여러 대상이면 대상마다 `send()`하고 공통 `groupId`를 붙인다
  - `status` → `status()`
- `session.mjs`는 수신 메시지를 대기열에 넣고 `pending`으로 응답한다. 주입을 확인하면 `client.ack(message, 'injected')`를 보낸다.
- 설정: `s8-config.yml`의 `communication`을 `{ enabled, url, tokenFile }`로 바꾼다.
- 통신 정체성은 comm-center의 `welcome.agentId`다. Projectman claim의 `workerId`는 바꾸지 않는다(위 "구현 중 바꾼 결정").
- 완료 확인: 매니저 세션과 워커 세션이 comm-center를 통해 왕복한다. 기존 `communication-service.test.mjs` 시나리오를 새 구조로 옮겨 통과시킨다.
- 결과: 확장 테스트 4개, 세션 테스트 2개, CLI 통합 테스트 1개 통과. CLI 테스트는 실제 Pi 워커 세션 2개와 `main.mjs`로 띄운 comm-center 프로세스로 왕복과 센터 재시작 후 재접속을 확인한다. Pi 확장 로더가 `pi/` 밖의 `apps/comm-center/client.mjs`를 불러오는 것과 Node 내장 WebSocket이 `Origin`을 보내지 않는 것도 이 테스트로 확인했다.

### 3단계: 이전 통신 경로 삭제 (완료)

아래 "삭제할 파일과 코드"를 지운다. 완료 확인: Pi 테스트(`node --test pi/test/*.test.mjs`, Pi에는 `npm test` 스크립트가 없다)와 `npm test --prefix apps/comm-center` 통과. `grep -rn "communicator\|listenLocal\|localRequest\|credentialsFile" pi`의 결과가 0건.

결과: Pi 테스트 159개 중 152개 통과, 실패 0, 7개 건너뜀. 건너뛴 7개는 PH-CMS 서버 의존성이 필요한 기존 테스트다. 전환 전 기준선은 162개 통과, 1개 실패였고, 그 실패는 `worker-mode` 테스트의 임시 폴더 정리 오류(`ENOTEMPTY`)로 이번 변경과 무관하다. 테스트 수가 줄어든 것은 이전 통신 테스트가 comm-center 쪽으로 옮겨 갔기 때문이다. grep 결과는 이전 키를 거부하는지 검증하는 테스트 한 곳뿐이다.

### 4단계: 실행과 문서 (완료)

- `start-infra.sh`에 `comm-center` 창을 추가한다. `apps/comm-center/.env`나 의존성이 없으면 창을 비워 둔다.
- README의 에이전트 메시지 통신 절, `s8-config.example.yml`, `docs/distributed-multi-agent-plan.md`를 새 구조로 다시 쓴다.
- 환경변수 변경을 루트 `.env.example`과 `apps/comm-center/.env.example`에 반영한다.

## 삭제할 파일과 코드

3단계에서 지운다. 줄 번호는 기준 커밋 `a144b79` 기준이다.

### 파일 삭제

| 파일 | 줄 수 | 대체 |
|---|---|---|
| `pi/lib/communication/server.mjs` | 61 | `apps/comm-center/server.mjs` |
| `pi/lib/communication/service.mjs` | 16 | 없음. 매니저도 클라이언트로 직접 연결 |
| `pi/lib/communication/local.mjs` | 67 | 없음. Unix 소켓 중계 제거 |
| `pi/lib/communication/peer.mjs` | 70 | `apps/comm-center/server.mjs`의 전달·확인·중복 방지 |
| `pi/lib/communication/credentials.mjs` | 24 | `apps/comm-center/registry.mjs`, 토큰 파일 |
| `pi/lib/communication/protocol.mjs` | 42 | `apps/comm-center/protocol.mjs` |
| `pi/lib/communication/client.mjs` | 44 | `apps/comm-center/client.mjs` |
| `pi/test/communication-network.test.mjs` | 124 | `apps/comm-center/server.test.mjs` |
| `pi/test/communication.test.mjs` | 36 | `apps/comm-center/server.test.mjs` (형식·라우팅 검증) |

삭제한 파일은 9개, 484줄이다. `communication-runtime.test.mjs`(131줄)와 `communication-service.test.mjs`(86줄)는 지우지 않고 같은 이름으로 다시 썼다. 남는 Pi 통신 코드는 `pi/extensions/communication.mjs`와 `pi/lib/communication/session.mjs` 둘이다.

### 코드 삭제

| 파일 | 위치 | 지울 내용 |
|---|---|---|
| `pi/bin/s8.mjs` | 52-72 | `runCommunicator` 함수 전체 |
| `pi/bin/s8.mjs` | 98-99 | `service communicator` 분기와 오류 문구의 `communicator` |
| `pi/bin/s8.mjs` | 상단 사용법 주석 | `service communicator` 줄 |
| `pi/lib/runtime/services.mjs` | 17 | `lockFiles.communicator` |
| `pi/lib/runtime/services.mjs` | 42-43 | `communication` 로드와 `communicator` 서비스 항목. `scheduler`만 남긴다 |
| `pi/lib/runtime/runtime.mjs` | 46 | `managed` 목록의 `'communicator'` |
| `pi/lib/runtime/user-command.mjs` | 23 | `service communicator` 도움말 줄 |
| `pi/lib/config/s8-config.mjs` | 73-97 | `normalizeCommunication`의 `nodeId`, `credentialsFile`, `server`(`bindIp`, `port`), `managerUrl` 검증. `enabled`, `url`, `tokenFile`만 남긴다 |
| `pi/extensions/communication.mjs` | 4-5 | `local.mjs`, `client.mjs` import |
| `pi/extensions/communication.mjs` | 22-26 | 매니저 `listenLocal`과 워커 전용 `startWorkerConnection` 분기. 역할 구분 없는 연결 하나로 바꾼다 |
| `pi/extensions/communication.mjs` | 39 | `taskUid`, `sessionId` 도구 인자 |
| `pi/extensions/communication.mjs` | 43-47 | `localRequest(... 'peers')` |
| `pi/extensions/communication.mjs` | 48-49 | 워커의 `workerIds` 거부와 다른 작업 가장 거부. 라우팅은 comm-center가 검사한다 |
| `pi/extensions/communication.mjs` | 59 | `taskUid` 자동 부착과 `sessionId` 전달 |
| `pi/extensions/communication.mjs` | 61 | `payload.sourceSessionId` |
| `pi/extensions/communication.mjs` | 62-64 | 역할별 전송 분기(`localRequest` / `connection.request`) |
| `pi/lib/communication/session.mjs` | 1 | `protocol.mjs` import |
| `pi/lib/communication/session.mjs` | 36-40 | `validateMessage`, 역할별 발신자 검사, `taskUid`·`sessionId` 거부. 발신자와 라우팅은 comm-center가 보장한다 |
| `pi/lib/communication/session.mjs` | 41 | `request.status` 처리. 상태 조회는 comm-center가 맡는다 |
| `pi/extensions/worker.ts` | 5 | "S8_WORKER_UID는 ... 통신 컨텍스트로 사용한다" 주석의 통신 부분 |
| `pi/extensions/worker.ts` | 5, 21-22 | `S8_WORKER_UID` 주석, `assigned` 변수, `registerCommunication`의 `role`·`workerId`·`taskUid` 인자 |
| `pi/lib/agent/launch.mjs` | 144 | `S8_WORKER_UID` 설정. 통신 `taskUid` 외에 쓰는 곳이 없어졌다 |
| `pi/extensions/manager.ts` | 29 | `registerCommunication`의 `role` 인자 |
| `pi/package.json` | dependencies | `ws`. 위 파일을 지우면 Pi에서 쓰는 곳이 없다 |

### 테스트 수정·삭제

| 파일 | 위치 | 처리 |
|---|---|---|
| `pi/test/pi-services.test.mjs` | 64-70 | communicator 창 테스트 삭제 |
| `pi/test/projectman-console.test.mjs` | 190-205 | `listenLocal` 기반 테스트 삭제. 콘솔이 통신 연결을 워커로 노출하지 않는다는 검증은 config 기반으로 남긴다 |
| `pi/test/s8-config.test.mjs` | 27, 53 | 기본값 모양을 `{ enabled: false, url: null, tokenFile: null }`로 바꿈 |
| `pi/test/s8-config.test.mjs` | 155-197 | `server`, `nodeId`, `credentialsFile`, `managerUrl` 테스트 삭제. `url`, `tokenFile` 검증 테스트로 교체 |
| `pi/test/worker-mode.test.mjs` | 216, 246 | fixture의 `communication` 설정을 새 형식으로 바꿈 |
| `pi/test/communication-session.test.mjs` | 10, 36-84 | `local.mjs` import, `taskUid` 기반 fixture와 `request.status` 검증 정리 |

### 문서·설정 예시 수정

| 파일 | 위치 | 처리 |
|---|---|---|
| `README.md` | 410-470 | 인증 파일 형식, `server`, `managerUrl`, `./s8.sh service communicator`, `S8_WORKER_ID` 실행 예시를 새 구조로 교체 |
| `README.md` | 72 | 거부하는 이전 키 목록에 `communication.server`, `nodeId`, `credentialsFile`, `managerUrl`을 추가 |
| `s8-config.example.yml` | 51-73 | `communication` 예시를 `enabled`, `url`, `tokenFile`로 교체 |
| `.env.example` | 마지막 3줄 | `communication.credentialsFile` 설명 삭제. `S8_WORKER_ID` 설명은 2단계 결과에 맞춰 고침 |
| `docs/distributed-multi-agent-plan.md` | 전체 | 새 구조로 다시 씀 |
| `agents/manager/SYSTEM.md`, `pi/skills/projectman*/SKILL.md` | `agent_message` 설명 | `taskUid`, `sessionId` 인자 언급 삭제 |

## 남기는 것

- `pi/lib/communication/session.mjs`의 대기·주입·주입 확인 로직
- `agent_message` 도구 이름과 동작(`list`, `request`, `reply`, `notice`, `proposal`, `result`, `status`)
- 로그에 대화 본문과 토큰을 남기지 않는다는 원칙
- 로컬 Projectman 실행, 상주 워커, `run_worker`, `set_worker_mode`. 이 전환과 별개다

## 위험과 확인할 점

- Node 내장 `WebSocket` 클라이언트는 커스텀 헤더와 `maxPayload`를 지정할 수 없다. 그래서 토큰은 첫 프레임으로 보낸다. 센터는 인증 전 소켓을 5초 뒤에 닫는다.
- 센터는 `Origin` 헤더가 있는 업그레이드를 거부한다. 브라우저 페이지가 접속하지 못하게 하기 위해서다. Node 내장 클라이언트는 `Origin`을 보내지 않는다(1단계 테스트에서 확인).
- comm-center는 WS만 제공한다. 장비 사이에는 암호화된 사설망을 쓰거나 TLS 프록시 뒤에서 WSS로 연다. 바인딩에 `0.0.0.0`, `::`는 허용하지 않는다.
- 2단계 전까지는 기존 communicator 코드와 comm-center가 함께 존재한다. 둘 다 기본 포트 8090을 쓰므로, project 모드 런타임에서 `communication.server`를 설정한 장비에서는 동시에 띄우지 않는다.

## 남은 작업

- [ ] **브랜치 커밋과 main 반영.** 작업은 worktree에 미커밋 상태로 있다. s8 general이 main 체크아웃에서 실행 중이므로, main에 반영하는 시점을 정해야 한다.
- [ ] **원본 체크아웃의 사본 정리.** `/home/sangbong/s8-agent`에 미추적 상태의 `apps/comm-center/`와 `docs/comm-center-plan_claude.md`(1단계 시점 사본)가 남아 있다. 브랜치를 반영하기 전에 지워야 충돌이 없다.
- [ ] **실제 원격 환경 확인.** 다른 장비 사이 연결과 TLS 프록시(WSS) 구성.
- [ ] **운영 규칙 적용.** 워커 장비마다 UID 없이 실행한 상시 세션을 둔다. 같은 토큰으로 두 세션이 연결되지 않게 하고, 상주 루프 작업 세션이 통신을 쓰려면 `S8_COMM_TOKEN_FILE`로 토큰을 나눈다.
- [ ] **(보류) 원격 보고 경로.** 원격 워커의 보고가 매니저 inbox에 닿지 않는 문제(`pi/lib/development/outbox.mjs:62`)가 있다. 지금은 워커 스킬이 `report` 후 `result` 메시지를 보내도록 안내한다.
- [ ] **(보류) 나머지 결합 축소.** `run_worker`·`set_worker_mode` 제거, `repoPath`를 워커 설정으로 옮기기, 역할별 설정 로더.
- [ ] **(보류) comm-center 확장.** 오프라인 보관, 재시작 없는 등록부 재로딩.


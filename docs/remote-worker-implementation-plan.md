# 로컬·원격 공통 워커 구현 계획

작성일: 2026-10-19. 상태: 구현 진행 중. 명시적 `worker-entries`, 인증된 HTTP long-poll 통신기, 로컬 Pi 공통 프로토콜, 원격 작업공간·패치 전송, managed SSH 기동·drain, Claude Code CLI 어댑터를 구현했다. 실제 두 장치 운영 검증은 아직 남아 있다. 임의로 이미 열려 있는 Claude TUI에 입력을 삽입하지 않고, 워커 런타임이 UID마다 전용 Claude Code print 세션을 시작한다.

## 1. 목표와 유지할 작업 흐름

워커를 **고유 식별자 + 공통 통신기 + Projectman MCP 연결**로 운용한다. 로컬 Pi와 원격 Claude Code는 같은 작업 배정·메시지·보고 계약을 사용하며, 에이전트를 시작하고 입력하는 방법만 어댑터로 구분한다. PH-CMS 소스와 DB 스키마는 변경하지 않는다.

```text
사람의 Telegram/Pi 지시 → 매니저의 work 계획 → 사람의 화면 실행 승인
  → 조정기(supervisor)의 claim → 연결된 유휴 워커에 UID·runId 배정
  → 워커가 Projectman MCP로 조회 → 자기 장치의 worktree에서 구현·검증
  → 산출물 업로드·완료 제출 → 기존 report outbox
  → Projectman review 저장 + 매니저 inbox + Telegram 개발 완료 알림
  → 워커 실행 종료 확인·반환 → 다음 독립 work

사람의 검토의견·완료 제출 → 원본 done → 매니저의 후속 작업 여부 판단
  → 필요한 경우 새 work 계획 → 별도 사용자 실행 승인
```

work당 토큰·시간·실행 횟수 제한이나 별도 재작업 로직을 추가하지 않는다. 연결 확인 시간과 HTTP 대기 시간은 작업 실행 예산이 아니다. 기존 서버의 승인·권한·의존성·상하위 작업 검증은 유지한다.

## 2. 현재 코드와 변경 이유

| 현재 구현 | 필요한 변경 |
| --- | --- |
| `workers.count`, `worker-1..N` 자동 생성 | `worker-entries`에 명시한 식별자와 실행 위치로 등록 (설정·로컬 Pi ID 적용 완료) |
| `worker-pool.mjs`의 로컬 Unix 소켓·PID 확인 | 로컬·원격이 같은 통신기에 인증·접속하고 상태를 등록 |
| supervisor가 로컬 worktree·request.json을 만들고 워커가 직접 읽음 | 경로를 공유하지 않는 배정 메시지와 장치별 작업 공간 준비 |
| `worker-session.mjs`가 Pi SDK와 로컬 projectman 도구를 직접 생성 | 공통 워커 계약과 Pi/Claude 실행 어댑터 분리 |
| 결과·패치를 같은 `.s8-runtime` 경로에서 읽음 | 원격 전송 후 중앙 실행 기록에 보존하고 기존 outbox로 연결 |
| tmux에서 모든 워커를 생성·중지 | managed/external 및 local/SSH 기동 방식 구분 |

현재 `bin/supervisor.mjs`는 별도 LLM 에이전트가 아니라 배정·보고·복구 데몬이다. 이 책임은 공통 조정기로 유지하고 에이전트 실행과 분리한다.

## 3. 설정 변경

예정인 `s8-config.yml` 형식:

```yaml
worker-entries:
  local-s8-1:
    agent: pi
    host: local
    launch: managed

  remote-claude-1:
    agent: claude-code
    host: ssh://dev@devbox
    launch: managed
    root: /home/dev/s8-agent

  remote-claude-2:
    agent: claude-code
    launch: external

worker-communicator:
  bindAddress: 100.100.0.10
  port: 38771
  url: http://100.100.0.10:38771

repository-mappings:
  /central/path/to/repository: /home/dev/work/repository
```

- 키가 workerId다. 이름에서 위치·모델·에이전트 종류를 추론하지 않는다. 서버의 기존 workerId 형식과 길이에 맞춰 검증한다.
- `agent`는 실행 어댑터를 선택한다. 첫 구현 대상은 `pi`, `claude-code`다.
- `host`는 기동 위치다. managed는 local 또는 SSH 주소가 필요하다. managed SSH에는 원격 s8-agent checkout의 절대 `root` 경로가 필요하다. external은 s8가 자동 기동하지 않으므로 SSH 주소와 root는 선택이다.
- `launch: managed`는 s8가 실행기 수명을 관리한다. `external`은 사용자가 실행기와 입력 어댑터를 연결한 세션의 접속을 기다린다.
- `workers.count`를 제거한다. 배정 가능한 수는 등록된 항목 중 실제 연결된 유휴 워커 수다. 빈 목록은 워커 0개이며 임의 워커를 생성하지 않는다.
- 공통 통신기 URL과 Projectman MCP URL을 설정할 위치도 확정한다. 워커마다 동일한 주소를 반복할 필요는 없다.
- `worker-communicator`는 loopback 또는 Tailscale IPv4에만 바인딩한다. 중앙 장치에서는 원격 장치가 접근할 Tailscale 주소를 사용한다.
- 장치별 `repository-mappings`는 승인된 중앙 `spec.repoPath`를 해당 장치의 checkout 절대 경로로 연결한다. `spec.repoPath` 자체는 바꾸지 않는다.
- 통신기 worker token은 `.s8-runtime/worker-auth/<workerId>.token`에 0600 권한으로 보관하고 보안 채널로 원격 장치에 전달한다. Projectman 서비스 키, Claude/Pi 모델 인증과 SSH 개인키는 YAML에 넣지 않는다.
- 에이전트 실행 명령을 임의 YAML 셸 문자열로 받기보다 명시적인 어댑터와 인자를 사용한다.

파서, 설정 CLI의 init/show/legacy migration, `s8-config.example.yml`, 시작 도움말과 관련 회귀 기준을 worker-entries로 전환했다. 기존 `workers.count` 파일은 `node pi/bin/s8-config.mjs migrate-workers`로 `worker-1..N` 항목에 명시적으로 변환한다. 환경변수 `PHCMS_MCP_URL`은 Claude Code 워커가 기존 Streamable HTTP Projectman MCP에 연결할 때 사용하며 `.env.example`에도 추가했다. 실제 `.env` 값은 문서화·테스트에 복사하지 않는다.

## 4. 구현에 필요한 구성 요소

### A. 공통 워커 레지스트리와 조정기

- 설정에 등록된 workerId만 인증·연결하도록 한다. 단순히 요청 본문의 이름을 신뢰하지 않고 인증 주체와 workerId를 연결한다.
- workerId, 연결 세대(connectionId), 에이전트 종류, 실행 상태, 현재 UID/runId를 관리한다. 같은 ID의 중복 접속과 이전 연결의 늦은 메시지를 구분한다.
- 기존 사용자 승인·사전 검토 확인, 담당자·예정 시각·의존성 확인과 원자적 claim을 재사용한다. claim은 조정기만 수행한다.
- 담당자가 없으면 연결된 유휴 워커를 선택한다. 담당자가 있으면 해당 ID에만 배정한다. 워커당 동시 실행은 한 건이다.
- 연결이 끊긴 실행은 상태 미확인으로 보존한다. heartbeat 유실만으로 취소·실패·유휴로 바꾸거나 다른 워커에 중복 배정하지 않는다.
- 재접속 시 중앙 기록과 워커의 UID/runId를 대조한 후 기존 실행을 이어서 관찰하거나 명시적으로 복구한다.

### B. 영속 통신기 서버와 공통 클라이언트

별도 메시지 브로커를 도입하지 않고 s8의 영속 기록·outbox·inbox를 확장한다. 로컬 워커도 원격과 같은 프로토콜을 사용한다.

| 기능 | 필수 동작 |
| --- | --- |
| 연결·상태 보고 | 인증, 프로토콜 버전 확인, workerId와 connectionId 연결 |
| 배정·메시지 수신 | 워커가 long polling으로 수신 대기. 메시지 수신 확인 전까지 보존 |
| 배정 수락 | messageId·workUid·runId를 대조하고 중복 수락으로 새 실행을 만들지 않음 |
| 진행·장애 메시지 | 원본 work/run에 연결해 매니저 inbox로 전달 |
| 완료 제출 | 결과·검증·산출물 참조를 영속 저장하고 기존 보고 outbox로 인계 |
| 취소·반환 | 활성 runId의 취소를 전달하고 실제 종료·보고 저장 후 슬롯을 반환 |

초기 전송 방식은 HTTP long polling이다. HTTPS 또는 Tailscale 내부 전송으로 구성하고, 통신기 바인딩 주소·포트·접속 범위를 운영 설정에서 확정한다. 워커가 s8로 접속하므로 원격 워커의 수신 포트는 필요 없다.

메시지에는 최소 `protocolVersion`, `messageId`, `workerId`, `connectionId`, `type`, 작업 메시지의 `workUid`, `runId`를 포함한다. 수신 확인과 업무 처리 완료를 구분한다. 메시지는 재전달될 수 있으므로 수신자가 처리 기록을 보존한다. 실행 중 메시지를 받았다는 사실을 새 실행 승인이나 계획 변경 승인으로 해석하지 않는다.

완료 호출은 결과의 접수와 최종 저장 완료를 구분한다. 산출물 보존·Projectman report와 실제 에이전트 턴 종료를 확인하기 전에 다음 work를 배정하지 않는다. 통신 단절 시 워커도 완료 결과를 로컬에 보존해 같은 runId/요청 ID로 재전송한다.

### C. 공통 워커 실행기와 에이전트 어댑터

- 작은 상주 실행기가 수신 대기·상태 보고·작업 공간 준비·에이전트 입력·산출물 전송을 담당한다.
- 에이전트에는 같은 워커 지침, 자기 workerId, 배정 UID/runId, 통신기 MCP와 Projectman MCP를 제공한다.
- Projectman MCP는 작업 조회에 사용한다. 최종 완료 제출은 통신기 한 경로로 모으고 조정기가 기존 report outbox로 서버에 반영한다. 워커가 별도로 claim/report해 두 경로의 상태를 경합시키지 않도록 노출 도구·공통 지침을 정리한다.
- Pi는 기존 SDK 실행·공개 도구 이벤트 기록을 재사용한다. Claude는 지원되는 프로그램 실행 인터페이스로 시작·입력·종료·도구 결과를 처리한다.
- UID별 새 대화와 독립 worktree를 기본으로 한다. 모델 내부 추론과 인증정보는 수집하지 않는다.
- 통신기 MCP 설정만 등록해도 대기 중 세션에 입력이 자동 전달되는 것은 아니다. 각 어댑터가 새 배정을 실제 입력으로 전달하고 종료를 감지하는 경로를 구현해야 한다.
- external은 단순히 켜져 있는 임의 CLI를 뜻하지 않는다. 통신기와 입력 어댑터가 연결되고 자동 입력·종료 확인이 검증된 세션이어야 한다. 기존 Claude 대화 재사용은 설치 버전의 입력/재개 기능을 검증하고 한 실행 주체가 소유한다. 지원되지 않는 세션은 전용 워커 대화로 시작한다.

### D. SSH 최초 기동과 수명 관리

SSH는 시작·진단·정상 종료에만 사용하며 평상시 업무 배정은 통신기로 처리한다.

1. 원격 장치의 필수 프로그램·실행기 버전·작업 디렉터리와 사전 인증 상태를 확인한다.
2. workerId 기준으로 중복 기동을 막고 tmux 또는 사용자 서비스에서 실행기를 유지한다. 첫 구현에서 사용할 프로세스 관리 방식을 하나로 정한다.
3. SSH 연결이 끝나도 실행기를 유지한다. SSH 명령 성공만으로 배정하지 않고 통신기 연결을 확인한다.
4. 정상 중지·재시작은 새 배정을 차단하고 현재 실행이 끝난 뒤 수행한다. 강제 종료는 명시적 요청에만 수행하고 실행 기록을 보존한다.
5. external 워커는 자동 기동·중지·재시작 대상에서 제외한다. 원격 장애가 로컬 매니저나 정상 워커의 시작을 막지 않게 한다.

`s8-worker start/status/stop` 같은 명령은 새로 구현할 후보 인터페이스이며 현재 설치된 명령이 아니다. SSH 실행 파일·인자를 분리하고 workerId·주소를 검증한다. 자격증명은 명령 인자와 로그로 전달하지 않는다.

### E. 저장소·작업 공간·산출물

원격 지원에서 필수인 부분이다. 로컬 절대 경로만 바꿔 보내는 방식으로는 후속 작업을 이어갈 수 없다.

- 배정에는 project UID, 저장소 식별자, 기준 커밋과 선행 실행 산출물 참조를 포함한다. 승인된 spec.repoPath를 원격 경로 때문에 다시 쓰지 않는다.
- 각 장치는 저장소 식별자를 자기 로컬 checkout 경로로 해석하고 필요한 커밋을 준비한다. 이 매핑·작업 루트 설정과 저장소 접근 인증을 마련한다.
- 같은 기준 커밋과 선행 패치로 작업 입력을 재현한다. 패치 충돌이나 커밋 부재를 조용히 무시하지 않는다.
- 결과는 요약, 검증, 판단·오류, 변경 파일, 기준 커밋과 패치로 수집한다. 최초 범위는 기존 Git binary patch 계약을 재사용한다.
- 변경을 전달한 선행 입력과 이번 work의 변경을 구분해 누적 패치의 중복 적용을 피한다. 실행 이벤트·결과·변경 패치와 다음 작업용 패치를 중앙 `.s8-runtime/runs/<runId>/` 계약에 맞게 보존한다.
- 전송은 임시 파일에 받고 해시·실행 소유권·파일 종류를 검증한 뒤 확정한다. 원격 장치의 임의 경로를 서버가 읽는 인터페이스를 만들지 않는다.
- 저장소·산출물 원격 전송 외에 중앙 객체 스토리지, 자동 커밋·푸시·머지는 추가하지 않는다. 필요한 저장소 fetch 권한은 장치 준비 사항으로 둔다.

### F. Projectman MCP 연결

기존 PH-CMS content-mcp는 Streamable HTTP와 요청별 서비스 키를 지원한다. 원격 장치에 PH-CMS나 MCP 서버를 복제하지 않는다.

```text
로컬/원격 워커 → http://<PH-CMS 장치 Tailscale IPv4>:3001/mcp → PH-CMS API
로컬/원격 통신기 → s8 통신기 endpoint → 조정기·매니저 inbox
```

- PH-CMS 장치와 원격 장치를 같은 접근 가능한 Tailscale 네트워크에 연결한다.
- MCP가 실제 Tailscale IPv4에 바인딩되어 있는지 확인한다. 루프백 바인딩만 되어 있으면 원격에서 접속할 수 없다.
- 현재 MCP의 Host 검증에 맞는 IP·포트 URL을 사용한다. 도메인·프록시·SSH 포워딩으로 바꿀 때는 이 검증을 포함해 확인한다.
- 원격 워커 실행 환경에 agent용 서비스 키를 제공하고 매 요청의 Authorization 헤더로 전달한다. 사람 JWT나 모델 로그인 자격증명과 혼용하지 않는다.
- MCP 접속 인증과 통신기의 workerId 인증은 별도 책임이다. Projectman 키가 있다는 이유만으로 다른 워커의 메시지를 수신할 수 없어야 한다.
- `pnpm dev -- --server --mcp` 등 기존 PH-CMS 실행 방식을 사용한다. 연결 설정 준비는 필요하지만 PH-CMS 코드를 변경하지 않는다.

## 5. 변경 대상과 재사용 범위

아래는 현재 파일 기준이다. 새 코드는 기존 역할별 폴더에 배치하고 별도 서비스·저장 계층을 중복 생성하지 않는다.

| 대상 | 작업 |
| --- | --- |
| `pi/lib/config/s8-config.mjs`, `pi/bin/s8-config.mjs`, `s8-config.example.yml` | entries 검증·설정 전환·기본 생성 및 표시 수정 |
| `pi/lib/development/worker-pool.mjs` | 번호 기반 슬롯·로컬 PID 판정을 레지스트리와 연결 상태로 대체 |
| `pi/lib/development/worker-daemon.mjs`, `worker-session.mjs`, `pi/bin/developer.mjs` | 공통 실행기와 Pi/Claude 어댑터 분리 |
| `pi/lib/development/supervisor.mjs`, `pi/bin/supervisor.mjs` | 공통 배정·복구·산출물 수신, 기존 claim/report/outbox 재사용 |
| `pi/lib/development/workspace.mjs` | 장치별 작업 공간 준비와 원격 선행 패치·결과 전송 연결 |
| `pi/lib/runtime/services.mjs`, `runtime.mjs`, `full-restart.mjs`, `start-pi.sh` | local/SSH 기동·external 제외·유휴 후 변경 및 재시작 |
| `pi/lib/manager/inbox.mjs`, `pi/extensions/manager.ts` | 워커 메시지 연결. 매니저 미접속 시 영속 전달 유지 |
| `pi/extensions/projectman.ts`, 워커·매니저 지침 | 임의 workerId와 공통 MCP 도구 사용, 역할별 claim/report 책임 반영 |
| 콘솔·Telegram·예약·완료 검토의견 경로 | 기존 업무 흐름 유지. 원격 결과도 기존 패치 다운로드·로그 조회·후속 work에서 사용 |
| `README.md`, `OPERATIONS.md`, 테스트·통합 테스트 실행기 | 설치·등록·시작·중지·장애 복구 안내와 새 계약 검증 |

## 6. 준비해야 할 환경

| 위치 | 준비 사항 |
| --- | --- |
| s8 장치 | 기존 PH-CMS/API·MCP·DB, 외부 워커가 접근할 통신기 주소, 영속 기록 공간 |
| managed 원격 장치 | SSH 로그인, 실행기 설치 경로, 프로세스 관리 도구, 필요한 런타임·Git·빌드 도구 |
| 모든 워커 장치 | 해당 에이전트 설치·인증, 공통 실행기·MCP 연결, 저장소 접근과 작업 공간 |
| 네트워크 | 통신기와 MCP로의 접근, managed 대상 SSH 접근. MCP는 기존 Tailscale 경로 사용 |
| 인증 준비 | 워커별 통신 인증, Projectman agent 키, 모델 인증, managed SSH 인증을 각각 준비 |
| 실장치 검증 | 로컬 Pi 1개와 원격 Claude 1개, 원격 테스트 저장소, 명시적인 테스트 알림 수신 대상 |

설치·로그인·저장소 접근 권한은 자동으로 생기지 않는다. 주소·경로·인증 제공 방식은 실제 장치에 맞춰 준비하고, 비밀 값은 문서·예시·Git에 기록하지 않는다.

## 7. 구현 순서와 전환

1. **설정과 계약**: worker-entries 스키마, 통신기 인증·메시지·재전달 계약, 저장소·산출물 형식을 확정한다.
2. **로컬부터 공통화**: 통신기와 공통 실행기를 만들고 기존 Pi 워커를 같은 프로토콜로 옮긴다. 기존 업무 회귀를 통과한다.
3. **장치 독립 실행**: 실행기에서 저장소·기준 커밋·선행 패치를 준비하고 중앙으로 산출물을 회수한다. 다른 임시 경로의 워커로 검증한다.
4. **원격 managed**: SSH 기동·진단·정상 중지, 원격 Pi/Claude 어댑터를 연결한다.
5. **external 연결**: 사용자가 준비한 세션의 입력 어댑터와 재접속·실행 소유권을 검증한다.
6. **운영 전환**: 실제 두 장치에서 승인부터 완료·검토의견·후속 작업까지 검증하고 문서를 갱신한다.

기존 count=N 설정은 전환 시 worker-1..N의 명시적 entries로 변환해 기존 담당자와 실행 기록을 보존한다. 장기적으로 count와 entries를 동시에 관리하지 않는다. 담당자 이름을 바꾸려고 승인된 spec을 자동 수정하지 않는다. 변경이 필요하면 기존 계획 변경·재승인 규칙을 따른다.

진행 중인 로컬 run은 기존 경로에서 종료·보고를 마친 후 통신 프로토콜을 전환한다. 작업 중 entries 삭제·변경은 새 배정을 막고 종료까지 기다린다. rollback도 진행 중인 새 프로토콜 실행과 미전송 산출물을 정리한 뒤 수행하며 상태 미확인 작업을 자동 재실행하지 않는다.

## 8. 검증과 완료 기준

- [x] count 없이 entries만으로 로컬/원격/external 등록. 잘못된 ID·주소·어댑터·미등록 연결 거부. (증거: `telegram-config` 항목 검증·거부, `worker-pool-lifecycle` managed/external, `worker-communicator` 401)
- [x] 로컬 Pi와 원격 Claude가 같은 배정 메시지와 MCP 작업 계약으로 수행. (증거: `worker-pool`, `remote-worker-workspace`, `worker-session-claude`, `pi-sdk`)
- [ ] managed 중복 시작 방지, SSH 종료 후 유지, external 자동 종료 금지. (fixture `ssh-worker`·`worker-pool-lifecycle` 통과, 실 SSH 대상 확인 남음)
- [x] 임의 workerId 담당자 배정, 동시 claim 중 하나만 성공, 워커당 실행 한 건. (증거: `worker-pool`)
- [x] 배정·결과·메시지 수신 확인 유실과 재전송에도 중복 실행·중복 완료 기록 없음. (증거: `worker-communicator`, `worker-pool`, `development-supervisor`)
- [x] 워커와 조정기 각각 재시작, 오래된 연결의 메시지, 통신 단절 중 작업 진행·취소를 복구. (증거: `worker-communicator` 재연결·이전 연결 409, `worker-pool-lifecycle`, `development-supervisor` 재시작·claim 복구)
- [ ] 다른 장치의 경로·기준 커밋·선행 패치를 사용해 입력 재현. 원격 결과로 다음 장치의 후속 work 수행. (fixture `remote-worker-workspace` 통과, 실 두 장치 확인 남음)
- [ ] 산출물 누락·손상·충돌·업로드 중단 시 성공 처리하지 않으며 원본 결과를 보존.
- [ ] 원격 완료도 Projectman review·매니저 inbox·Telegram 링크와 콘솔 패치/기록 조회로 연결. (로컬 통합은 통과, 실 원격 확인 남음)
- [x] 사람의 검토의견·done·매니저의 새 work 판단과 별도 실행 승인 유지. (증거: PH-CMS 통합 검증 `humanCompletion`·`managerReports`, `completion-review`)
- [x] 워커 인증 위조·다른 run 결과·이전 연결의 늦은 완료를 거부. 실제 비밀 값은 테스트에 사용하지 않음. (증거: `worker-communicator` 401·400·409)
- [x] 기존 Node 회귀, 프런트엔드 테스트·빌드, PH-CMS 기존 계약 통합 검증 통과. (증거: Node 154, 프런트엔드 57+build, PH-CMS 통합 1)
- [ ] 로컬 네트워크 fixture 검증 후 실제 두 장치의 기동·입력 전달·원격 저장소·결과 전송을 검증. fixture 통과만으로 실장치 완료를 선언하지 않음.

코드 구현은 설정과 로컬 공통 프로토콜에서 원격 작업 공간·산출물 전송, managed SSH, Claude Code 실행 어댑터까지 진행했다. 2026-10-19에 전체 Node 회귀(154), 프런트엔드 테스트(57)·빌드, PH-CMS 기존 계약 통합(1)을 실행해 통과했다. 그 과정에서 `worker-pool` deferred `count` 반환과 `pi-runtime` 테스트 fixture의 누락된 전이 의존성을 수정했다. 남은 미완은 실장치 항목이다: managed SSH/external 실기동, 두 장치 간 Tailscale·SSH·MCP end-to-end, 원격 산출물 손상·업로드 중단 처리 검증. 남은 범위와 실행 순서는 [remote worker handoff](remote-worker-handoff.md)를 따른다. 이 기준이 통과되기 전에는 원격 운영 완료로 간주하지 않는다.

# 에이전트 메시지 통신 구조

현재 통신 범위는 실행 중인 Pi 세션 사이의 텍스트 송수신이다. 설치·인증·실행 예시는 [README](../README.md#에이전트-메시지-통신)에 있다.

## 연결 구조

```text
Manager Pi ← Unix socket → communicator ← WebSocket → Worker Pi
```

- `service.mjs`: 서버와 매니저 Pi의 로컬 소켓을 연결한다. `peers`는 연결 정보만 반환한다.
- `server.mjs`: 워커별 토큰을 검사하고 매니저와 워커 사이의 메시지를 전달한다. HTTP 파일 전송 경로는 없다.
- `client.mjs`: 기존 워커 Pi 세션이 직접 소유하는 연결이다. 연결 단절 후 재접속하지만 요청을 재전송하지 않는다.
- `peer.mjs`·`protocol.mjs`: 메시지 검증, 요청·응답 연결, 제한된 중복 방지, 전달 확인과 timeout/unknown 처리.
- `local.mjs`: 매니저 Pi와 서버 사이의 사용자 전용 Unix 소켓.
- `session.mjs`: 현재 모델·도구 실행이 끝나면 수신 메시지를 추가한다. 세션 기록에서 추가된 것을 관찰해야 injected로 응답한다.
- `extensions/communication.mjs`: 에이전트의 agent_message 도구와 세션 시작·종료 수명 주기를 연결한다.

워커는 UID 없이도 연결할 수 있다. 별도의 resident 프로세스·Projectman 설정·저장소 매핑은 요구하지 않는다. 동일 워커 ID의 중복 연결은 거부한다. 여러 동시 세션에는 서로 다른 ID와 인증 항목을 사용한다. 존재하지 않는 수신 세션을 자동 생성하지 않는다.

## 설정과 메시지

`communication`에는 enabled, nodeId, credentialsFile, server(bindIp/port), managerUrl만 허용한다. 활성화에는 nodeId와 credentialsFile 및 server 또는 managerUrl이 필요하다. 서버 전용 장비에는 managerUrl이 필요 없다. 인증 파일은 검증된 비공개 일반 파일이어야 한다.

프로토콜은 메시지 전용 v2다. 이전 실행 제어 프로토콜과의 혼용은 handshake에서 거부한다. 메시지는 agent.request/reply/notice/proposal/result, 전달 확인은 request.status/result만 허용한다. taskUid와 sessionId는 수신 대상 확인에 사용하며 실행 권한을 만들지 않는다. 워커는 Manager에게만 보낼 수 있다. 수신 텍스트는 에이전트의 후속 응답을 유발하며 기존 도구 권한과 승인 범위를 따른다.

pending은 대기, injected는 세션 기록 추가, unavailable은 대상 부재, unknown은 확인 불가를 뜻한다. 업무 완료 상태와 구분한다. 오프라인 전달·영속 요청 큐·재시작 후 자동 재전송은 제공하지 않는다.

## 유지하는 경계

인증·송신자 확인·heartbeat·재연결·메시지 크기/빈도/대기 수 제한·중복 방지·회신 연결·세션 일치 검사를 유지한다. 로그에 대화 본문이나 토큰을 남기지 않는다. 암호화된 사설망 또는 WSS를 사용한다.

Projectman 작업 실행·로컬 상주 워커 모드·claim/report/outbox·수동 복구는 작업 실행 계층의 기능으로 유지한다. 통신 활성화가 로컬 작업 제어를 원격 호출로 전환하지 않는다. 콘솔의 상주 워커 목록에는 로컬 설정된 워커만 표시한다.

원격 작업 실행·모드 변경·실행 상태 조회, 조사 에이전트 자동 생성·복구·응답 기한 관리, 파일 업로드·다운로드, 저장소 매핑, Git 산출물 게시·반영은 제거했다. 기존 repositories 설정은 삭제해야 하며 알 수 없는 설정으로 거부한다. 예전 런타임·산출물 파일은 자동으로 삭제하지 않는다.

## 검증

프로토콜·네트워크·서비스 테스트는 메시지 왕복, 인증·중복 연결 거부, 파일 HTTP 경로 부재, 실행 제어 메시지 거부, 유휴 워커 수신과 기존 세션 fan-out을 검증한다. SDK 테스트는 실행 중인 턴 이후의 세션 기록과 전달 확인을 검증한다. CLI 통합 테스트는 별도 체크아웃·tmux 서버·로컬 모의 모델로 Projectman 없는 세션 간 왕복과 서버 재시작 후 재연결을 검증한다. 실제 별도 장비의 네트워크·TLS 구성은 배포 환경에서 확인한다.

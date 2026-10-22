# 에이전트 메시지 통신 구조

현재 통신 범위는 실행 중인 Pi 세션 사이의 텍스트 송수신이다. 설치·인증·실행 예시는 [README](../README.md#에이전트-메시지-통신)와 [comm-center README](../apps/comm-center/README.md)에 있다. 전환 경위와 삭제 목록은 [comm-center 전환 작업계획](comm-center-plan_claude.md)을 참고한다.

## 연결 구조

```text
매니저 Pi ─┐
워커 Pi  ──┼─ WebSocket ─ apps/comm-center
워커 Pi  ──┘
```

- `apps/comm-center/server.mjs`: 토큰으로 정체성과 역할을 정하고, 매니저 ↔ 워커 메시지를 전달한다. 발신자는 센터가 인증된 정체성으로 채운다. 전달 확인 중계, 중복 방지, 크기·빈도·대기 수 제한, heartbeat를 맡는다. HTTP 경로는 없다.
- `apps/comm-center/client.mjs`: 세션마다 하나인 재접속 연결. Node 내장 WebSocket만 쓴다. 연결이 끊기면 미확정 요청은 `unknown`이 되고 재전송하지 않는다.
- `apps/comm-center/protocol.mjs`·`registry.mjs`: 프레임 검증과 라우팅 규칙, 토큰 해시 등록부와 토큰 파일.
- `pi/extensions/communication.mjs`: `agent_message` 도구와 세션 시작·종료 수명 주기. 매니저와 워커가 같은 코드를 쓴다.
- `pi/lib/communication/session.mjs`: 현재 모델·도구 실행이 끝나면 수신 메시지를 세션에 추가한다. 세션 기록에서 추가된 것을 관찰한 뒤 `injected` 확인을 보낸다.

워커는 UID 없이도 연결할 수 있다. 별도의 resident 프로세스·Projectman 설정·저장소 매핑은 요구하지 않는다. 같은 토큰의 중복 연결은 거부한다. 존재하지 않는 수신 세션을 자동 생성하지 않는다.

## 설정과 메시지

에이전트 장비의 `communication`에는 `enabled`, `url`, `tokenFile`만 허용한다. 이전 통신 서버의 `server`·`nodeId`·`credentialsFile`·`managerUrl`은 알 수 없는 설정으로 거부한다. comm-center 자체 설정은 `apps/comm-center/.env`의 등록부 경로·바인딩 IP·포트다. 등록부와 토큰 파일은 검증된 비공개 일반 파일이어야 하며, 등록부에는 토큰 해시만 둔다.

프로토콜은 comm-center v1이다. 버전이 다르면 연결 직후 거부한다. 메시지 종류는 `request`·`reply`·`notice`·`proposal`·`result`이고, 전달 확인은 `ack`·`status`로 다룬다. 매니저는 워커에게, 워커는 매니저에게만 보낼 수 있다. 워커가 수신자를 생략하면 등록된 매니저에게 간다. 수신 텍스트는 에이전트의 후속 응답을 유발하며, 워커는 매니저의 지시를 기존 도구 권한과 승인 범위 안에서 수행할 수 있다. 메시지가 권한을 만들지는 않는다.

`pending`은 수신 세션 대기, `injected`는 세션 기록 추가, `rejected`는 거부, `unavailable`은 대상 미접속, `unknown`은 확인 불가를 뜻한다. 업무 완료 상태와 구분한다. 오프라인 전달·영속 요청 큐·재시작 후 자동 재전송은 제공하지 않는다.

## 유지하는 경계

인증·발신자 확인·heartbeat·재연결·메시지 크기/빈도/대기 수 제한·중복 방지·회신 연결을 유지한다. 로그에 대화 본문이나 토큰을 남기지 않는다. 브라우저 연결(`Origin` 헤더)은 거부한다. 암호화된 사설망 또는 WSS를 사용한다.

Projectman 작업 실행·로컬 상주 워커 모드·claim/report/outbox·수동 복구는 작업 실행 계층의 기능으로 유지한다. 통신 활성화가 로컬 작업 제어를 원격 호출로 전환하지 않는다. 콘솔의 상주 워커 목록에는 로컬 설정된 워커만 표시한다.

## 검증

comm-center 테스트는 정체성 부여와 왕복, 라우팅 거부, fan-out, 중복 전송 방지, 미확인·연결 끊김 시 `unknown`, 센터 재시작 후 재접속, 인증·버전·브라우저·중복 정체성 거부, 발신자 위조와 남의 확인 차단, 끊긴 연결 감지, 등록부 권한과 동시 등록을 검증한다. Pi 확장 테스트는 별도 루트의 세션이 실제 comm-center로 왕복하는 것을 검증한다. SDK 테스트는 실행 중인 턴 이후의 세션 기록과 주입 확인을 검증한다. CLI 통합 테스트는 별도 tmux 서버의 comm-center 프로세스와 로컬 모의 모델로 Projectman 없는 세션 간 왕복과 센터 재시작 후 재연결을 검증한다. 실제 별도 장비의 네트워크·TLS 구성은 배포 환경에서 확인한다.

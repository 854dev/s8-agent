# s8 comm-center

매니저·워커 에이전트가 텍스트를 주고받는 중계 서버다. 인증, 라우팅(매니저 ↔ 워커), 중복 방지, 전달 확인, 크기·빈도 제한, heartbeat를 맡는다. 오프라인 보관과 재전송은 하지 않는다. 프로토콜과 전환 계획은 [comm-center 작업계획](../../docs/comm-center-plan_claude.md)을 참고한다.

Pi의 `agent_message` 확장(`pi/extensions/communication.mjs`)이 이 앱의 `client.mjs`로 접속한다. 에이전트 장비 설정은 [README의 에이전트 메시지 통신](../../README.md#에이전트-메시지-통신)을 참고한다.

## 실행

```bash
npm ci --prefix apps/comm-center
cp apps/comm-center/.env.example apps/comm-center/.env   # 경로·IP·포트를 이 장비에 맞게 고친다
npm start --prefix apps/comm-center
```

## 에이전트 등록

```bash
npm run issue --prefix apps/comm-center -- ~/.config/s8/comm-center-agents.json manager manager ~/.config/s8/comm-manager.json
npm run issue --prefix apps/comm-center -- ~/.config/s8/comm-center-agents.json a worker ~/.config/s8/comm-a.json
```

- 등록부에는 토큰 해시만 저장한다. 토큰 원문은 지정한 토큰 파일(권한 600)에만 쓰고 화면에 출력하지 않는다.
- 토큰 파일은 해당 에이전트의 장비로 옮긴다. 이미 있는 토큰 파일은 덮어쓰지 않는다.
- 등록부를 바꾸면 comm-center를 재시작한다.
- 에이전트를 차단하려면 등록부에서 그 항목을 지우고 재시작한다.
- 이미 등록된 ID로 다시 발급하면 해시가 바뀐다(토큰 교체). 이전 토큰은 재시작 후 거부된다.
- 등록은 한 번에 하나만 한다. 동시에 실행하면 등록부 옆의 `.lock` 파일 때문에 거부된다.

## 클라이언트

`client.mjs`는 Node 내장 `WebSocket`만 쓰므로 이 앱의 의존성 없이 가져다 쓸 수 있다.

```js
import { connectCommCenter } from '../apps/comm-center/client.mjs';
import { readTokenFile } from '../apps/comm-center/registry.mjs';

const client = connectCommCenter({ url: 'ws://10.0.0.10:8090', token: await readTokenFile(tokenFile), onMessage: message => 'pending' });
await client.send({ to: 'manager', type: 'notice', text: '작업을 시작했습니다.' });
```

## 보안

- 바인딩은 루프백이나 실제 사설망 IP 하나로 한다. `0.0.0.0`·`::`는 받지 않는다.
- 내장 서버는 WS만 제공한다. 장비 사이에는 암호화된 사설망이나 TLS 프록시의 WSS를 쓴다.
- `Origin` 헤더가 있는 연결(브라우저)은 거부한다.
- 로그에는 연결·메시지 ID·전달 상태·지연만 남기고 본문과 토큰은 남기지 않는다.

## 테스트

```bash
npm test --prefix apps/comm-center
```

# s8 MCP Hub

Gmail, Google Calendar, `854_md` 할일 도구를 하나의 Streamable HTTP MCP 엔드포인트로 제공한다. 별도 사용자 설정 없이 `local` 사용자가 자동 생성된다.

## 실행

```bash
cd apps/mcp-hub
npm ci
npm run build
npm start
```

MCP URL:

```text
http://127.0.0.1:8790/mcp
```

상태 확인:

```bash
curl http://127.0.0.1:8790/health
curl http://127.0.0.1:8790/status
```

## OAuth 설정

OAuth client 파일을 다음 기본 경로에 둔다.

```text
.s8-runtime/mcp-hub/gmail/gcp-oauth.keys.json
.s8-runtime/mcp-hub/google-calendar/gcp-oauth.keys.json
```

사용자 ID 없이 provider만 지정해 인증한다.

```bash
npm run auth -- gmail
npm run auth -- google-calendar
```

토큰은 `.s8-runtime/mcp-hub/<provider>/tokens/local.json`에 저장되며 Git에 포함되지 않는다.

## 설정

- `S8_KB_ROOT`: 지식베이스 경로. 기본값은 `../854_md`
- `MCP_HUB_HOST`: 기본값 `127.0.0.1`. 인증이 없으므로 루프백만 허용
- `MCP_HUB_PORT`: 기본값 `8790`
- `MCP_HUB_USER`: 내부 사용자 ID. 기본값 `local`
- `MCP_GMAIL_ENABLED`, `MCP_GOOGLE_CALENDAR_ENABLED`: provider 활성화 여부

자세한 경로·도구 제한은 [`.env.example`](.env.example)을 참고한다.
`.env.example`을 `.env`로 복사하면 실행 명령이 자동으로 읽는다.

## 검증

```bash
npm test
npm run build
```

# S8 라우터

상위 정책과 운영 절차는 [`../../README.md`](../../README.md)의 인프라와 웹 콘솔 절을 따른다.

`router.mjs`는 의존성 없는 Node 프로세스다. `s8-config.yml`의 `network.bindIp:httpPort` 하나로 받아 경로별로 로컬 서비스에 전달한다. `./start-infra.sh`가 `s8-infra` 세션의 `router` 창에서 실행한다.

## 경로

| 경로 | 전달 대상 |
| --- | --- |
| `/health` | 라우터 자체 응답 |
| `/api/docs/health` | KB Browser `127.0.0.1:8787/health` |
| `/api/docs/`, `/api/files/upload` | KB Browser `127.0.0.1:8787` |
| `/api/terminal/` | 터미널 게이트웨이 `127.0.0.1:8790` (WebSocket 포함) |
| `/api/projectman/` | Projectman 콘솔 API `127.0.0.1:8791` |
| `/api/v2/` | PH-CMS `127.0.0.1:8000` |
| `/s8/` | frontend `127.0.0.1:4178` (Vite HMR WebSocket 포함) |

그 밖의 경로는 404다. 지식 문서를 정적 파일로 직접 공개하지 않는다. 요청 본문은 200MB까지 받는다.

## 직접 실행

저장소 루트에서 실행한다.

```bash
eval "$(node pi/bin/s8-config.mjs shell-env)"   # S8_KB_ROOT, S8_BIND_IP, S8_HTTP_PORT
node infra/router/router.mjs
curl -fsS "http://$S8_BIND_IP:$S8_HTTP_PORT/health"
```

- Tailscale 전용으로 쓸 때는 실제 Tailscale IPv4를 `network.bindIp`로 지정한다. `0.0.0.0`은 설정에서 거부한다.
- 기본 포트는 80이다. 리눅스는 일반 사용자에게 1024 미만 포트를 막으므로 [README의 80번 포트 허용](../../README.md#80번-포트-허용-리눅스)을 한 번 적용한다. macOS는 필요 없다.

## 공개 경계

- 차단: `.pi/`, `.s8-runtime/`, `.git/`, `SECRET/`, `secret/`, `node_modules/`
- 업로드 저장소: `.s8-runtime/data/uploads/`
- 쓰기 API 추가 전 별도 인증과 승인 정책을 정의한다.

## 검증

```bash
node --test pi/test/router.test.mjs
```

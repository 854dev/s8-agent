# s8 Nginx Router

상위 정책은 [`../../INFRASTRUCTURE.md`](../../INFRASTRUCTURE.md), 실제 운영 절차는 [`../../OPERATIONS.md`](../../OPERATIONS.md)를 따른다.

## 역할

- `/s8/`을 호스트 frontend preview로 전달
- `/api/docs/`를 `kb-browser`로 전달
- `/health` 제공
- 지식 문서의 정적 직접 공개 방지

## 직접 실행

```bash
NGINX_BIND_IP=127.0.0.1 \
  docker compose -f infra/nginx/docker-compose.yml up -d --build
```

Tailscale 전용으로 사용할 때는 실제 Tailscale IPv4를 `NGINX_BIND_IP`로 지정한다. `0.0.0.0`은 모든 인터페이스에 열릴 수 있다.

상태 확인:

```bash
docker compose -f infra/nginx/docker-compose.yml ps
```

설정 검사:

```bash
docker compose -f infra/nginx/docker-compose.yml \
  run --rm --no-deps nginx nginx -t
```

중지:

```bash
docker compose -f infra/nginx/docker-compose.yml down
```

## 공개 경계

- 허용: 공개 경계에 포함되는 일반 Markdown 문서
- 차단: `.pi/`, `.s8-runtime/`, `.git/`, `SECRET/`, `secret/`, `node_modules/`
- 업로드 저장소: `.s8-runtime/data/uploads/`
- 쓰기 API 추가 전 별도 인증과 승인 정책을 정의한다.

## Verify

```bash
docker compose -f infra/nginx/docker-compose.yml config
docker compose -f infra/nginx/docker-compose.yml \
  run --rm --no-deps nginx nginx -t
```

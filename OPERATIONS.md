# s8 운영 절차

인프라 기준은 [`INFRASTRUCTURE.md`](INFRASTRUCTURE.md)를 따른다. Pi 실행 외에는 tmux, npm, Docker Compose, curl의 표준 명령을 직접 사용한다.

## 최초 설치와 로그인

```bash
cd /path/to/s8-agent
npm ci --ignore-scripts --prefix pi
./start-pi.sh
```

Pi가 열리면 `/login`을 실행한다. credential과 세션은 `.pi-runtime/`에 저장되며 Git과 에이전트 도구의 접근 대상에서 제외된다. 기존 `.pi/`에 있던 인증정보와 세션은 자동으로 옮기지 않는다. 필요하면 사용자가 별도 백업·이관하고, 그렇지 않으면 `/login`으로 다시 인증한다.

## Pi 실행

```bash
./start-pi.sh
./start-pi.sh --continue
./start-pi.sh --resume
```

`start-pi.sh`는 다음 역할만 담당한다.

- 프로젝트 로컬 Pi 바이너리 선택
- 루트 `.env`를 읽고 작업 디렉터리를 `${S8_KB_ROOT:-../854_md}`로 고정
- 인증정보와 세션을 `.pi-runtime/`로 분리
- `pi/settings.json`을 런타임 설정 링크로 참조하며, 공유 extension, skill, 시스템 지침은 `pi/`에서 로드
- 사용할 기본 파일 도구 명시

## S8 관리 세션과 웹 터미널

```bash
./start-pi.sh --sessions
./start-pi.sh --session main
./start-pi.sh --session main --telegram
npm start --prefix apps/terminal-gateway
```

- 기존 세션에는 재실행 없이 접속하며 `--telegram`은 그 세션으로 polling 소유권을 이전한다.
- 웹에서는 `/s8/terminal`이 기본으로 호스트 셸 `s8-host-shell`에 연결된다. S8 Pi 세션도 선택할 수 있다.
- `셸 열기`는 고정 셸을 생성·재사용한다. 브라우저 연결 해제는 셸을 종료하지 않는다. 모바일 입력은 보조 키 버튼을 사용한다.
- 설치, 네트워크 경계와 복구 절차는 [`apps/terminal-gateway/README.md`](apps/terminal-gateway/README.md)를 따른다.

## tmux 활용

현재 터미널에서 새 세션을 만들고 바로 접속:

```bash
tmux new-session -s pi-854-md -c "$PWD" "./start-pi.sh"
```

백그라운드에서 시작:

```bash
tmux new-session -d -s pi-854-md -c "$PWD" "./start-pi.sh"
```

접속, 분리, 상태 확인, 종료:

```bash
tmux attach-session -t pi-854-md
# 세션 안에서 Ctrl-b, d로 분리
tmux has-session -t pi-854-md
tmux kill-session -t pi-854-md
```

frontend를 같은 tmux 세션의 별도 창에서 실행하려면 다음을 사용한다.

```bash
tmux new-window -t pi-854-md -n frontend -c "$PWD" \
  "npm run preview --prefix frontend -- --host 127.0.0.1 --port 4178"
```

## frontend 준비와 실행

```bash
npm ci --ignore-scripts --prefix frontend
npm run build --prefix frontend
npm run preview --prefix frontend -- --host 127.0.0.1 --port 4178
```

상태 확인:

```bash
curl -fsS http://127.0.0.1:4178/s8/
```

## Docker Compose와 Nginx

로컬 전용 실행:

```bash
NGINX_BIND_IP=127.0.0.1 \
  docker compose -f infra/nginx/docker-compose.yml up -d --build
```

Tailscale 전용 실행:

```bash
tailscale ip -4
NGINX_BIND_IP=<TAILSCALE_IP> \
  docker compose -f infra/nginx/docker-compose.yml up -d --build
```

상태와 로그:

```bash
docker compose -f infra/nginx/docker-compose.yml ps
docker compose -f infra/nginx/docker-compose.yml logs --tail 100 nginx kb-browser
```

Nginx 설정 검사:

```bash
docker compose -f infra/nginx/docker-compose.yml \
  run --rm --no-deps nginx nginx -t
```

중지:

```bash
docker compose -f infra/nginx/docker-compose.yml down
```

`down`은 서비스를 중단하므로 사용자의 명시적 요청이나 승인 후 실행한다.

## 상태 점검

```bash
./start-pi.sh --version
tmux has-session -t pi-854-md
curl -fsS http://127.0.0.1:4178/s8/
docker compose -f infra/nginx/docker-compose.yml ps
curl -fsS http://<BIND_IP>/health
curl -fsS http://<BIND_IP>/api/docs/health
curl -fsS -H 'Accept: text/html' http://<BIND_IP>/s8/knowledge-base
```

## PH-CMS 프록시

- PH-CMS는 호스트 `127.0.0.1:8000`에서 별도로 실행한다. Nginx 설정만으로 서버가 시작되지는 않는다.
- `/api/v2/`는 원래 URI를 유지해 PH-CMS로 전달한다. `/s8/`, 문서·업로드·터미널 경로는 그대로 유지한다.
- 관리자 로그인: `http://<TAILSCALE_IP>/api/v2/admin/login`
- 관리자 UI의 API URL은 같은 Tailscale origin, API prefix는 `/api/v2`로 지정한다. 원격 장치에서 `localhost:8000`을 지정하지 않는다.
- 관리자 로그인 후 키 발급 요청은 PH-CMS 관리자 페이지의 같은 origin에서 실행한다. Nginx는 별도 관리자 인증을 제공하지 않으며 PH-CMS 인증·권한 검사를 유지한다.
- 검증 후 무중단 적용: `docker exec 854md-nginx nginx -t && docker exec 854md-nginx nginx -s reload`
- 상태 확인: `curl -fsS http://<TAILSCALE_IP>/api/v2/health`
- `/api/v2/`만 502이면 PH-CMS 실행 상태와 컨테이너에서 `host.docker.internal:8000` 접근을 확인한다.
- 롤백은 `/api/v2/` location과 `phcms_api` upstream을 제거하고 설정 검사·reload를 수행한다. PH-CMS DB와 S8 세션에는 영향을 주지 않는다.

## PH-CMS MCP 인증 연결

- PH-CMS 루트에서 기존 명령 `pnpm dev -- --server --mcp`로 API와 MCP를 함께 실행한다. MCP 호스트 기본값은 현재 Tailscale IPv4이며 추가 실행 스크립트는 필요 없다.
- MCP만 실행할 때는 `pnpm --filter @ph-cms/content-mcp dev`를 사용한다. 직접 실행의 기본 호스트는 `127.0.0.1`이다. Tailscale 접근이 필요하면 `PHCMS_MCP_HOST`에 실제 Tailscale IP를 지정한다.
- 별도 실행과 통합 실행을 동시에 사용하지 않는다. 설정이 없더라도 MCP는 정상 기동하고 초기화·도구 목록을 제공한다.
- MCP는 JSON 설정 파일을 읽지 않는다. API 연결 설정은 `PHCMS_BASE_URL`·`PHCMS_API_PREFIX`·`PHCMS_TIMEOUT_MS`와 기본값만 사용한다. 인증 키는 저장하지 않으며 S8 `.env`도 읽지 않는다.
- S8은 기존 `PHCMS_ACCESS_TOKEN`에 보관한 서비스 키를 MCP 요청의 `Authorization: Bearer ...`로 전송한다. MCP는 요청별 클라이언트로 같은 헤더를 PH-CMS API에 전달한다. 키 원문은 출력하거나 기록하지 않는다.
- 키가 없으면 API 도구만 오류를 반환하고 잘못된 헤더·JWT는 401로 거부한다. 유효성·만료·권한은 PH-CMS가 검증하며 계정 로그인으로 전환하지 않는다.
- 키 변경은 S8 클라이언트 설정에서 한다. MCP 재시작은 필요 없다. 변경된 환경을 로드하려면 S8과 스케줄러를 재시작한다. 기존 서버 JSON은 더 이상 사용하지 않는다.

## 장애 분리

Pi가 시작되지 않음:

- Node.js 22.19.0 이상인지 확인한다.
- `npm ci --ignore-scripts --prefix pi`를 다시 실행한다.
- `pi/node_modules/.bin/pi` 존재 여부를 확인한다.
- credential 문제면 Pi를 열어 `/login`을 다시 실행한다.

Nginx `/health` 실패:

- Docker daemon 상태를 확인한다.
- `NGINX_BIND_IP`가 현재 장비에 존재하는 주소인지 확인한다.
- Compose 상태와 Nginx 로그를 확인한다.

API health만 실패:

- `kb-browser` 컨테이너 상태와 로그를 확인한다.
- `npm test --prefix apps/kb-browser`를 실행한다.

`/s8/`만 502:

- `127.0.0.1:4178` 응답을 확인한다.
- frontend build와 preview 프로세스를 확인한다.

## 보안 규칙

- `.pi/`, `.pi-runtime/`, `.s8-runtime/`, `.git/`, 비밀정보 경로를 지식베이스 API나 에이전트 도구로 제공하지 않는다.
- credential과 세션 원문을 로그나 문서에 복사하지 않는다.
- 외부 Pi package와 extension은 실행 전 소스와 권한을 검토한다.
- 공개 bind와 인증 정책 변경은 사용자 승인을 받는다.

## 검증 명령

```bash
bash -n start-pi.sh
./start-pi.sh --version
NGINX_BIND_IP=127.0.0.1 docker compose --env-file /dev/null -f infra/nginx/docker-compose.yml config --quiet
npm test --prefix apps/terminal-gateway
npm test --prefix apps/kb-browser
npm run test:run --prefix frontend
npm run build --prefix frontend
git diff --check
```

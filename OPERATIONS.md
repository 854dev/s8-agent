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
  "npm run preview --prefix frontend -- --host 0.0.0.0 --port 4178"
```

## frontend 준비와 실행

```bash
npm ci --ignore-scripts --prefix frontend
npm run build --prefix frontend
npm run preview --prefix frontend -- --host 0.0.0.0 --port 4178
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
docker compose -f infra/nginx/docker-compose.yml config
npm test --prefix apps/kb-browser
npm run test:run --prefix frontend
npm run build --prefix frontend
git diff --check
```

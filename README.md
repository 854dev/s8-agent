# s8-agent (scheduler 854)

`854_md` 지식베이스를 사용하는 개인용 AI 작업 오케스트레이터와 운영 콘솔이다. 지식과 에이전트 설정을 각각 `854_md`, `s8-agent` 저장소로 분리한다.

기본 배치는 두 저장소가 형제 디렉터리인 구조다.

```text
dev_854/
├── 854_md/       # 지식베이스
└── s8-agent/    # 에이전트 설정·실행 코드
```

## 구성

- 재사용 Pi 설정과 npm 패키지: `pi/`
- Pi 장비별 런타임: `.pi-runtime/`
- Pi 실행 진입점: `start-pi.sh`
- 비공개 로컬 상태: `.s8-runtime/`
- 웹 콘솔: `frontend/`
- 지식베이스 API: `apps/kb-browser/`
- Nginx와 Compose: `infra/nginx/`

## 빠른 시작

요구 사항:

- Node.js 22.19.0 이상
- npm
- Docker
- tmux

```bash
cd /path/to/s8-agent
npm ci --ignore-scripts --prefix pi
./start-pi.sh
```

Pi가 열리면 `/login`으로 이 장비의 모델 인증을 설정한다. 인증정보와 세션은 `.pi-runtime/`에 저장되며 Git과 에이전트 도구의 접근 대상에서 제외한다. 공유 설정의 원본은 `pi/settings.json`이며 런타임에서 이 파일을 링크로 참조한다.

이후 실행:

```bash
./start-pi.sh
./start-pi.sh --continue
```

Pi Web UI 실행:

```bash
./start-pi-web-ui.sh
```

브라우저에서 `http://127.0.0.1:8788`을 연다. 포트나 bind 주소를 바꾸려면 환경변수를 사용한다.

```bash
PI_WEB_HOST=127.0.0.1 PI_WEB_PORT=8789 ./start-pi-web-ui.sh --no-browser
```

tmux에서 Pi를 유지하려면 저장소 루트에서 다음을 사용한다.

```bash
tmux new-session -s pi-854-md -c "$PWD" "./start-pi.sh"
```

`854_md`가 형제 디렉터리가 아니면 명시적으로 지정한다.

```bash
S8_KB_ROOT=/path/to/854_md ./start-pi.sh
```

## 다른 장비에서 재현

```bash
git clone <knowledge-base-url> 854_md
git clone <s8-agent-url> s8-agent
cd s8-agent
npm ci --ignore-scripts --prefix pi
./start-pi.sh
```

- `package-lock.json`으로 동일한 Pi 버전과 npm 의존성을 설치한다.
- `pi/`의 npm 잠금 파일, 설정, extension, skill, 시스템 지침을 모든 장비에서 공유한다.
- `.pi-runtime/`은 각 장비의 인증정보, 세션, 캐시, 설치 패키지를 보관한다. 공유 설정은 복사하지 않는다.
- 모델 인증, 세션, 로그, 업로드는 장비마다 별도로 유지한다.

## Pi 패키지

s8에서 사용하는 Pi 패키지는 다음 목록을 기준으로 설치한다.

```bash
./start-pi.sh install npm:@calesennett/pi-codex-usage@0.1.14
./start-pi.sh install npm:pi-web-ui@0.96.1
./start-pi.sh install npm:@dietrichgebert/ponytail@4.10.0
./start-pi.sh install npm:pi-web-access@0.33.0
./start-pi.sh install npm:pi-mcp-extension@1.5.0
```

- `@calesennett/pi-codex-usage`: Codex 사용량 footer 표시
- `pi-web-ui`: 브라우저 기반 Pi Web UI, 한국어 언어팩 지원
- `@dietrichgebert/ponytail`: 과잉 구현 방지와 최소 구현 지향 스킬
- `pi-web-access`: 웹 검색, URL fetch, GitHub clone, PDF와 미디어 분석 도구
- `pi-mcp-extension`: MCP 서버 연결용 클라이언트 확장

## 작업 정책

- 작업 전 루트 `AGENTS.md`와 관련 프로젝트 문서를 확인한다.
- 사용자 승인 없이 외부 전송, 배포, 삭제 또는 중요한 방향 확정을 수행하지 않는다.
- 작업 상태와 실행 이력은 향후 별도 데이터 저장소에서 관리한다.
- 별도 저장소가 연결되기 전에는 작업 상태 파일을 만들지 않고 Pi 세션만 사용한다.
- 비밀정보와 `.pi/`, `.pi-runtime/`, `.s8-runtime/` 내용을 읽거나 문서화하지 않는다.
- Pi extension은 전체 시스템 권한으로 실행되므로 저장소에서 검토한 코드만 사용한다.

## Pi와 tmux

```bash
./start-pi.sh
./start-pi.sh --continue

tmux new-session -d -s pi-854-md -c "$PWD" "./start-pi.sh"
tmux attach-session -t pi-854-md
tmux kill-session -t pi-854-md
```

## 관련 문서

- 인프라 정책: [`INFRASTRUCTURE.md`](INFRASTRUCTURE.md)
- 운영 절차: [`OPERATIONS.md`](OPERATIONS.md)
- 구현 계획: [`IMPLEMENTATION_PLAN_V0.md`](IMPLEMENTATION_PLAN_V0.md)
- 작업 파일 구조: [`FILE_STORAGE_STRUCTURE_V0.md`](FILE_STORAGE_STRUCTURE_V0.md)

## Verify

```bash
./start-pi.sh --version
bash -n start-pi.sh
docker compose -f infra/nginx/docker-compose.yml config
git diff --check
```

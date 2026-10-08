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
- MCP 허브: `apps/mcp-hub/`
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
./start-pi.sh --telegram              # Telegram을 연결할 때만 명시
./start-pi.sh --telegram --continue
```

tmux에서 Pi를 유지하려면 저장소 루트에서 다음을 사용한다.

```bash
tmux new-session -s pi-854-md -c "$PWD" "./start-pi.sh"
```

`start-pi.sh`는 저장소 루트의 `.env`를 항상 읽는다. 기본 설정을 복사한 뒤 지식베이스 경로를 바꾸면 된다.

```bash
cp .env.example .env
```

```dotenv
S8_KB_ROOT=/path/to/workspace
```

상대 경로는 `s8-agent` 루트 기준이며 `.env`는 Git에 포함되지 않는다.

## Telegram 연동 (Pi 터미널 세션 공유)

기존 `~/.pi/agent/telegram.json`은 자동으로 읽거나 복사하지 않는다. 봇 토큰과 허용할 사용자 또는 그룹 ID를 사용자가 직접 설정한다. 기존 `TELEGRAM_ALLOWED_CHAT_IDS`는 더 이상 사용하지 않는다. `s8-agent/.env`에 다음을 추가한다(기존 항목은 덮어쓰지 않는다).

```dotenv
S8_KB_ROOT=/path/to/existing/workspace
TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_ALLOWED_USER_IDS=123456789,987654321
TELEGRAM_ALLOWED_GROUP_IDS=-1001234567890,-1009876543210
```

두 허용 목록 중 하나만 설정해도 된다. 개인 채팅은 `from.id`가 허용 사용자 목록에 있어야 한다. 그룹·슈퍼그룹은 `chat.id`가 허용 그룹 목록에 있어야 하며, 그 그룹의 **모든 참여자**가 봇을 사용할 수 있다. 허용된 사용자가 미등록 그룹에서 보낸 메시지는 무시한다. 그룹 전체 메시지를 받으려면 BotFather의 privacy mode 설정을 별도 확인한다. 그룹 권한이 과도하다면 그룹 ID 대신 개인 채팅의 사용자 ID만 사용한다. 토큰이나 ID를 Git에 넣지 않는다.

```bash
cd /path/to/s8-agent
chmod 600 .env
./start-pi.sh --telegram
```

`./start-pi.sh --help`로 실행 방법을 확인할 수 있다. 기본 실행은 Telegram을 연결하지 않는다(토큰이 설정돼 있어도 polling하지 않음). `--telegram`을 지정하면 Pi 터미널 안에서 Telegram을 연결한다. 같은 장비에서 여러 Pi 터미널이 실행되면 마지막에 시작한 인스턴스가 Telegram을 맡고, 종료되면 이전 인스턴스가 다시 연결한다. 첫 번째로 메시지를 보낸 허용 채팅에만 해당 터미널을 연결하며, 다른 채팅은 응답하지 않는다. 터미널과 연결된 Telegram 채팅은 같은 대화와 도구 진행을 공유한다. `/help`, `/status`, `/abort`를 지원하며 새 대화(`/new`)는 터미널에서만 수행한다. 기존 독립 Telegram 세션은 자동 이관하지 않는다. 오프라인 중 전송된 메시지는 재연결 시 재실행하지 않고 건너뛴다. 다른 장비에서 같은 봇 토큰으로 polling하지 않는다. Telegram 요청 중 Pi 확인 대화상자가 열리면 중단을 요청한다. 터미널에서 추가 확인이 필요한 작업은 직접 처리한다. 민감한 결과를 다루는 작업은 Telegram으로 요청하지 않는다. 정규식 기반 redaction은 완전한 유출 방지책이 아니다.

검증: `node --test apps/telegram-gateway/gateway.test.mjs`

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
./start-pi.sh install npm:@dietrichgebert/ponytail@4.10.0
./start-pi.sh install npm:pi-web-access@0.33.0
./start-pi.sh install npm:pi-mcp-extension@1.5.0
```

- `@calesennett/pi-codex-usage`: Codex 사용량 footer 표시
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

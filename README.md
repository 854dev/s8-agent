# s8-agent (scheduler 854)

`854_md` 지식베이스를 사용하는 개인용 AI 작업 오케스트레이터와 운영 콘솔이다. 지식과 에이전트 설정을 각각 `854_md`, `s8-agent` 저장소로 분리한다.

기본 배치는 두 저장소가 형제 디렉터리인 구조다.

```text
dev_854/
├── 854_md/       # 지식베이스
├── s8-agent/     # 에이전트 설정·실행 코드
└── ph-cms/       # 선택: Projectman API·MCP 서버
```

## 구성

- 재사용 Pi 설정과 npm 패키지: `pi/`
- Pi 장비별 런타임: `.pi-runtime/`
- Pi 실행 진입점: `start-pi.sh`
- 비공개 로컬 상태: `.s8-runtime/`
- 웹 콘솔·업로드·xterm.js 터미널: `frontend/`
- 호스트 PTY·tmux 웹 터미널 게이트웨이: `apps/terminal-gateway/`
- Telegram 명령·알림: `apps/telegram-gateway/`
- 예약 작업 실행 진입점: `start-scheduler.sh`
- 예약 CRUD·실행·배치 제어: `pi/extensions/scheduler.ts`, `pi/lib/scheduler-*.mjs`
- 지식베이스·업로드 API: `apps/kb-browser/`
- MCP 허브: `apps/mcp-hub/`
- Nginx와 Compose: `infra/nginx/`

## 빠른 시작

요구 사항:

- Node.js 22.19.0 이상과 npm
- Pi의 지속 실행·웹 터미널에는 tmux
- 예약 쉘 스크립트에는 Bash. Windows에서는 Git Bash 등으로 제공
- 웹 인프라 배포에는 Docker와 Tailscale. Pi CLI만 사용할 때 Docker는 필요 없음

```bash
cd /path/to/s8-agent
npm ci --ignore-scripts --prefix pi
./start-pi.sh
```

Pi가 열리면 `/login`으로 이 장비의 모델 인증을 설정한다. 인증정보와 세션은 `.pi-runtime/`에 저장되며 Git과 에이전트 도구의 접근 대상에서 제외한다. 공유 설정의 원본은 `pi/settings.json`이며 런타임에서 이 파일을 링크로 참조한다. 현재 기본 provider/model은 `openai-codex` / `gpt-6-sol`이다.

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

## 웹 터미널

- `/s8/terminal`은 기본으로 호스트 셸에 접속한다. 설정 편집·명령 실행과 모바일 보조 키를 지원하며 S8 Pi 세션도 선택할 수 있다.
- `./start-pi.sh --sessions`로 목록, `./start-pi.sh --session main`으로 생성·접속한다.
- `./start-pi.sh --session main --telegram`으로 실행 중인 세션에 Telegram 연결을 이전한다.
- backend 설치·실행, Tailscale 전용 노출 및 복구는 [`apps/terminal-gateway/README.md`](apps/terminal-gateway/README.md)를 따른다.
- 별도 웹 인증은 없으므로 Tailscale IP와 ACL을 접근 권한 경계로 유지한다. 셸은 호스트 사용자 권한으로 실행되며 Pi의 파일 보호 확장은 직접 터미널 입력을 제한하지 않는다.
- 글자 크기·전체화면·모바일 붙여넣기를 지원한다. Nerd Font 아이콘은 웹폰트로 제공하고 한글·다른 언어는 클라이언트의 시스템 폰트로 대체한다.
- 웹 대시보드의 작업 카드와 로그는 아직 샘플 데이터이며 실제 예약 상태 화면이 아니다. 화면별 연결 상태는 [`frontend/README.md`](frontend/README.md)를 참고한다.

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

`./start-pi.sh --help`로 실행 방법을 확인할 수 있다. 기본 실행은 Telegram을 연결하지 않는다(토큰이 설정돼 있어도 polling하지 않음). `--telegram`을 지정하면 Pi 터미널 안에서 Telegram을 연결한다. 같은 장비에서 여러 Pi 터미널이 실행되면 마지막에 시작한 인스턴스가 Telegram을 맡고, 종료되면 이전 인스턴스가 다시 연결한다. 첫 번째로 메시지를 보낸 허용 채팅에만 해당 터미널을 연결하며, 다른 채팅은 응답하지 않는다. 터미널과 연결된 Telegram 채팅은 같은 대화와 도구 진행을 공유한다. 텔레그램 키보드에서 상태, 중단, 배치, 새 대화, 모델 선택, 재시작, 도움말을 사용할 수 있으며 `/help`, `/status`, `/abort`, `/new`, `/model`, `/restart`, `/jobs` 명령도 지원한다. `/jobs`는 모델 호출 없이 예약 목록·정지·재개·실행 중인 배치 중단을 처리한다. `/status`는 현재 세션의 입력·출력·캐시 토큰 누계를 표시한다. 재시작은 동일한 실행 옵션으로 Pi를 다시 열고 현재 세션을 이어간다. 기존 독립 Telegram 세션은 자동 이관하지 않는다. 오프라인 중 전송된 메시지는 재연결 시 재실행하지 않고 건너뛴다. 다른 장비에서 같은 봇 토큰으로 polling하지 않는다. Telegram 요청 중 Pi 확인 대화상자가 열리면 중단을 요청한다. 터미널에서 추가 확인이 필요한 작업은 직접 처리한다. 민감한 결과를 다루는 작업은 Telegram으로 요청하지 않는다. 정규식 기반 redaction은 완전한 유출 방지책이 아니다.

검증: `node --test apps/telegram-gateway/gateway.test.mjs`

## 다른 장비에서 재현

```bash
git clone <knowledge-base-url> 854_md
git clone <s8-agent-url> s8-agent
cd s8-agent
npm ci --ignore-scripts --prefix pi
./start-pi.sh
```

- `pi/package-lock.json`으로 동일한 Pi 버전과 npm 의존성을 설치한다.
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
- 작업 메모 폴더와 진행 이력 Markdown은 만들지 않고 작업 맥락은 Pi 세션에 유지한다.
- 예약·최근 실행 상태는 스케줄러의 비공개 로컬 런타임에 저장하며, Projectman 상태·작업 로그는 PH-CMS가 관리한다. 웹 대시보드에 이 상태가 자동 연결되지는 않는다.
- 비밀정보와 `.pi/`, `.pi-runtime/`, `.s8-runtime/` 내용을 읽거나 문서화하지 않는다.
- Pi extension은 전체 시스템 권한으로 실행되므로 저장소에서 검토한 코드만 사용한다.

## 스케줄러

S8 대화의 `scheduler` 도구로 승인한 쉘 작업을 CRUD하고 별도 Node 데몬으로 실행한다.

```bash
./start-scheduler.sh
```

- 매일 `HH:mm` 또는 1~60분 중 60을 나누는 주기를 지원한다. 30분 예약은 매시 :00·:30에 검사한다.
- 데몬이 중지된 동안의 실행은 따라잡지 않는다. 호스트당 인스턴스 하나만 운영하며 다른 장치와 상태를 동기화하지 않는다.
- Telegram의 `/jobs`, `/jobs pause ID`, `/jobs resume ID`, `/jobs stop ID`로 예약과 현재 배치를 관리한다. 중단은 이미 수행한 변경을 롤백하지 않는다.
- OS 자동 시작 등록은 별도다. 비정상 종료 후 남은 잠금은 프로세스 종료를 확인한 뒤 수동 복구한다.
- Projectman 카운트 테스트는 작업별 예정 시각과 순서를 확인하고 결과 UID 기록으로 중복 차감을 막는다. 일반 자연어 작업을 자동 실행하는 기능은 아니다.

설정·승인·알림·복구 절차는 [`pi/SCHEDULER.md`](pi/SCHEDULER.md)를 참고한다.

## PH-CMS·Projectman 연결

- S8이 비관리자 agent 서비스 키를 `PHCMS_ACCESS_TOKEN`에 보관한다. 변수 이름은 기존 호환성을 유지하지만 MCP 호출에는 JWT가 아닌 서비스 키가 필요하다.
- Projectman 도구는 `PHCMS_API_URL`의 API를 직접 사용하며, 카운트 테스트 실행기는 MCP 요청에 `Authorization: Bearer <서비스 키>`를 보낸다.
- MCP는 그 요청의 헤더를 PH-CMS API에 전달할 뿐 키를 저장하거나 S8 환경 파일을 읽지 않는다. MCP의 JSON 설정 파일은 사용하지 않는다.
- PH-CMS 루트에서 `pnpm dev -- --server --mcp`로 API·MCP를 실행한다. 서버·관리자 UI·MCP의 API prefix를 같은 값으로 맞춘다. 현재 카운트 테스트 CLI의 MCP URL은 장비별 소스 설정이므로 다른 장비에서는 변경해야 한다.
- Nginx의 `/api/v2/`는 PH-CMS API·관리자 UI로 프록시하며, MCP는 별도의 `/mcp` 엔드포인트를 사용한다.
- 인증정보는 읽어 자동 이관하거나 로그·Git에 기록하지 않는다. 설정·재시작 안내는 [`OPERATIONS.md`](OPERATIONS.md)의 PH-CMS MCP 절을 참고한다.

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

## 검증

저장소 루트에서 실행한다.

```bash
node --test pi/test/*.test.mjs apps/telegram-gateway/gateway.test.mjs
npm run test:run --prefix frontend
npm run lint --prefix frontend
npm run build --prefix frontend
bash -n start-pi.sh start-scheduler.sh
git diff --check
```

웹 터미널 backend와 Nginx의 별도 검증은 [`apps/terminal-gateway/README.md`](apps/terminal-gateway/README.md)를 참고한다.

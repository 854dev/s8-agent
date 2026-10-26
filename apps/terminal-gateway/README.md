# S8 웹 터미널

## 구성

- xterm.js → WebSocket → 호스트 PTY → 호스트 tmux 세션
- 별도 로그인은 없다. Tailscale ACL에서 신뢰하는 디바이스만 접근하도록 제한한다.
- 웹 터미널은 호스트 사용자 권한으로 작동한다. Pi의 파일 보호 확장은 직접 터미널 입력을 제한하지 않는다.
- 기본 접속 대상은 고정된 호스트 셸 `s8-host-shell`이다. 설정 파일 편집과 `gh`, Pi 명령을 직접 실행할 수 있다.
- backend 시작 시 셸을 생성·재사용하고, 브라우저에서는 기본으로 그 셸에 접속한다. 세션 선택에서 PHCMS·S8 스케줄러·작업 워커·Pi 등 같은 호스트 사용자와 tmux 서버의 모든 세션에 접속할 수 있다. `s8-` 접두사나 `@s8-managed` 표시는 필요하지 않다.
- 임의 세션 이름이나 shell 명령을 서버 생성 API에 전달하지 못한다. `셸 열기`는 고정 셸만 생성·재사용한다.
- 터미널 출력은 저장하거나 서버 로그로 남기지 않는다.

## 실행

```bash
./s8.sh --session main
./s8.sh --sessions
./s8.sh --session main --telegram
npm ci --prefix apps/terminal-gateway
npm start --prefix apps/terminal-gateway
npm ci --ignore-scripts --prefix frontend
npm run build --prefix frontend
npm run preview --prefix frontend -- --host 127.0.0.1 --port 4178
./start-infra.sh   # 라우터 포함. config.yml의 network.bindIp를 Tailscale IPv4로 지정
```

- 실행 명령은 `s8-agent` 루트 기준이다. 라우터 IP는 `config.yml`의 `network.bindIp`에 실제 장비의 Tailscale IPv4로 지정한다.
- 브라우저 접속: `http://<Tailscale-IP>/s8/terminal`
- Host 검증 때문에 현재는 Tailscale IP 또는 localhost URL을 사용한다. MagicDNS 이름은 지원하지 않는다.
- `s8.sh --session 이름`은 해당 Pi와 공유 스케줄러를 재시작하고 창 목록만 출력한다. 기본은 `s8-main`이며 `pi`·`scheduler`·`shell` 창을 가진다. 작업 워커는 `s8-workers` 세션의 UID 창이다. 웹 터미널에서 이 세션을 선택하고 Ctrl+B, W로 창을 전환한다. `--sessions`는 이 관리 Pi 세션만 표시하며, 웹 터미널의 전체 호스트 세션 목록과 별개다.
- 관리 세션별 대화 기록은 `.pi-runtime/managed/s8-이름/`으로 분리한다. 기존 기록은 자동 이관하지 않는다.
- 기본 실행은 Telegram을 연결하고 마지막 실행 세션이 연결을 가져온다. `--telegram`은 기본 동작의 별칭이며 `--no-telegram`은 Telegram 확장 없이 단독 실행한다. 연결 확인은 로컬 제어 소켓을 사용한다. 토큰과 허용 채팅 설정이 기존대로 필요하다.
- `목록 새로고침`으로 현재 실행 중인 호스트 tmux 세션을 조회한다. 웹 연결은 목록에 존재하는 정확한 세션 이름으로 접속한다. tmux 밖의 프로세스와 다른 사용자·별도 tmux 소켓의 세션은 이 목록에 표시하지 않는다.
- 새 호스트 셸의 작업 디렉터리는 `s8-agent` 루트이며 호스트의 기본 셸을 사용한다. 같은 이름의 기존 세션은 내용과 소유 표시를 바꾸지 않고 재사용한다. `exit`하면 종료되고 `셸 열기`로 다시 생성할 수 있다.
- PHCMS 등 서비스 세션을 선택해 로그 확인·입력·중단을 수행한다. tmux 밖의 서비스는 호스트 셸에서 해당 서비스의 운영 명령으로 제어한다. 서비스 프로세스를 자동으로 다시 시작하지 않는다.
- 새 웹 접속마다 tmux 클라이언트만 붙인다. 창을 닫거나 게이트웨이를 종료해도 서비스 세션은 유지된다.
- 여러 클라이언트가 같은 Pi 입력과 화면 크기를 공유한다. 동시 입력을 자동 중재하지 않는다.
- backend는 기본 `127.0.0.1:8790`에서 실행하고 라우터가 같은 호스트에서 전달한다. 공인/LAN 주소 또는 전체 인터페이스로 노출하지 않는다.
- `node-pty`는 네이티브 모듈이므로 지원되는 Node.js/OS 환경이 필요하다. macOS prebuilt 실행 권한은 `prepare-pty.mjs`에서 보정한다.

## 모바일 입력

- 세션 선택기와 목록 새로고침은 항상 표시하며, 실행 중인 `s8-main`·`s8-infra`를 목록 앞에 배치한다. 나머지 연결 설정은 접어 둔다. 보조 키는 화면 아래 두 줄에 유지되며 좌우로 밀어 사용할 수 있다.
- `전체화면`에서도 글자 크기와 보조 키를 계속 사용할 수 있다. 브라우저 Fullscreen API를 지원하지 않거나 거부하면 웹 화면을 채우는 모드로 동작한다. 이 경우 브라우저 주소창까지 숨기지는 않는다.
- `A−` / `A+`로 글자 크기를 8~24px 범위에서 조절한다. 연결을 다시 만들지 않고 xterm 글꼴과 PTY 화면 크기를 갱신한다. 기본 크기는 12px이다.
- 화면 회전과 모바일 키보드 표시 시 Visual Viewport 크기에 맞춰 터미널과 도구 모음을 재배치한다.
- `키보드` 버튼으로 입력창에 포커스를 준다.
- Esc, Tab, Enter, 삭제, 방향키 및 Ctrl+C/D/L/B 버튼을 제공한다.
- `Ctrl`을 누르면 다음 문자 한 번에 Ctrl을 적용한다. 다시 누르면 해제한다.
- Ctrl+C는 작업 중단, Ctrl+D는 EOF, Ctrl+B 다음 키는 tmux 명령이다.
- `붙여넣기` 입력창을 길게 눌러 텍스트를 붙여넣고 `입력 보내기`로 전송한다. HTTP에서도 사용할 수 있도록 클립보드 조회 API를 요구하지 않는다.
- Enter는 자동으로 덧붙이지 않는다. 붙여넣은 텍스트 자체에 줄바꿈이 있으면 명령이 실행될 수 있으므로 확인한다.
- 실제 모바일 브라우저의 키보드 동작은 장치별로 확인해야 한다.

## 검증과 복구

```bash
npm test --prefix apps/terminal-gateway
node --test pi/test/managed-sessions.test.mjs pi/test/telegram-extension.test.mjs pi/test/telegram-ownership.test.mjs
npm run test:run --prefix frontend
npm run build --prefix frontend
bash -n start-general-agent.sh start-manager-agent.sh start-worker-agent.sh
bash -n s8.sh
node --test pi/test/router.test.mjs
curl -fsS http://100.120.50.80/api/terminal/health
```

- 기존 Pi 세션을 종료하지 않고 backend와 frontend·라우터만 갱신한다. 오래된 Pi는 새 관리 확장을 로드해야 연결 이전이 가능하다.
- backend 장애 시 터미널 목록/연결 실패를 표시한다. 재연결 버튼으로 다시 접속한다.
- 긴급 차단은 게이트웨이 프로세스를 종료하거나 `infra/router/router.mjs`의 `/api/terminal/` 경로를 제거한다. tmux에서 로컬 접속은 계속 가능하다.
- 롤백 시 backend와 웹 터미널 경로만 제거하고 Pi 대화 파일은 유지한다.

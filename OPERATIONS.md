# s8 운영 절차

인프라 기준은 [`INFRASTRUCTURE.md`](INFRASTRUCTURE.md)를 따른다. Pi 관리 실행은 `start-pi.sh`, 통합 인프라 실행은 `start-infra.sh`를 사용하고, 그 밖에는 tmux, npm, Docker Compose, curl의 표준 명령을 사용한다.

## Telegram 전체 재시작

- 업데이트된 코드를 받은 후 기존 `/restart`로 새 명령을 로드한다.
- `/restart`는 현재 Pi만 재시작한다. `/restart all` 또는 `전체 재시작` 버튼은 공유 실행기 정리 → 인프라 재시작 → 준비 확인 → 현재 Pi·스케줄러·슈퍼바이저 재시작 순서로 실행한다.
- Telegram 허용 채팅 정책을 그대로 적용하며 모델 호출이나 추가 셸 명령을 받지 않는다. 작업 중이면 `/abort` 후 실행한다.
- 제어 프로세스는 Pi와 웹 터미널이 종료돼도 계속 실행한다. 원래 채팅과 토픽으로 결과를 보내고, `.s8-runtime/runtime-restarts/실행ID/`에 단계와 결과를 저장한다. 토큰은 실행 요청 파일에 저장하지 않는다.
- 인프라 준비 확인에 실패하면 기존 Telegram Pi를 유지해 결과 확인과 `/restart all` 재시도를 할 수 있다. 진행 중인 전체 재시작이 있으면 중복 실행하지 않는다. 이 명령은 git pull이나 의존성 설치를 수행하지 않는다.

## 최초 설치와 로그인

```bash
cd /path/to/s8-agent
npm ci --ignore-scripts --prefix pi
./start-pi.sh
tmux attach-session -t s8-main
```

Pi 창이 열리면 `/login`을 실행한다. credential과 세션은 `.pi-runtime/`에 저장되며 Git과 에이전트 도구의 접근 대상에서 제외된다. 기존 `.pi/`에 있던 인증정보와 세션은 자동으로 옮기지 않는다. 필요하면 사용자가 별도 백업·이관하고, 그렇지 않으면 `/login`으로 다시 인증한다.

## Pi 실행

```bash
./start-pi.sh
./start-pi.sh --continue
./start-pi.sh --session work
```

`start-pi.sh`는 다음 역할만 담당한다.

- 기본 `s8-main` 세션에 `pi`·`scheduler`·`supervisor`·`shell` 창을 준비한 뒤 자동 접속 없이 목록 출력 (PH-CMS 별도 실행)
- 프로젝트 로컬 Pi 바이너리 선택
- 루트 `.env`를 읽고 작업 디렉터리를 `${S8_KB_ROOT:-../854_md}`로 고정
- 인증정보와 세션을 `.pi-runtime/`로 분리
- `pi/settings.json`을 런타임 설정 링크로 참조하며, 공유 extension, skill, 시스템 지침은 `pi/`에서 로드
- 사용할 기본 파일 도구와 `projectman`·`scheduler` 도구 명시

## Telegram ID 설정

- 봇 토큰과 PH-CMS 서비스 키는 환경변수에만 유지한다. `s8-config.yml`에는 `telegram.allowedUserIds`, `allowedGroupIds`, `scheduleChatId`만 저장한다.
- S8 Telegram 연결·독립 게이트웨이·스케줄러·부재중 운영 CLI는 같은 설정 로더를 사용한다. 파일이 있으면 ID 설정은 파일만 사용하며, 잘못된 파일은 환경변수로 우회하지 않는다.
- 파일이 없으면 기존 ID 환경변수로 동작한다. 파일의 빈 허용 목록은 접근을 막고, `scheduleChatId: null`은 예약 알림을 보내지 않는다. 대상은 허용 목록의 개인 또는 그룹이어야 한다.
- 이미 환경이 로드된 프로세스에서 `node pi/bin/s8-config.mjs init`으로 기존 ID만 이관한다. 저장소 루트 기준이며 인증정보를 읽어 복사하지 않고 기존 파일도 덮어쓰지 않는다. 일반 사용자 셸에 ID 환경이 없으면 예시 파일을 참고해 직접 준비한다.
- `node pi/bin/s8-config.mjs show`로 비인증 설정과 출처를 검증한다. 허용 사용자 제거·그룹 추가는 접근 권한에 영향을 주므로 사용자 승인 범위에서만 변경한다.
- 변경 후 S8의 Telegram 연결과 스케줄러를 재시작한다. 기존 Pi가 polling 소유권을 다시 얻을 때도 파일 정책을 새로 읽는다. 이미 연결된 프로세스에 모든 변경이 즉시 반영되는 것은 아니다.
- 롤백은 파일을 제거하고 기존 ID 환경변수로 재시작한다. 파일은 Git 제외 대상이며 작업 데이터·발급된 서비스 키·봇 토큰은 변경하지 않는다.

## 작업요청 등록

- PH-CMS의 `POST /projectman/intakes/preview`, `POST /projectman/intakes`, `GET /projectman/intakes/:requestId`가 있는 버전을 먼저 적용하고 S8을 재시작한다. API prefix는 기존 `PHCMS_API_URL`을 사용하며 새 환경변수·서비스 키·DB 마이그레이션은 없다. 운영 서버 적용은 별도 승인 후 수행한다.
- `intake_source`가 허용된 MD 파일 또는 실제 사용자 메시지를 원문 그대로 캡처한다. 모델이 원문을 다시 써서 전달하지 못하며 `sourceId`의 페이지 조회로 분석한다. 파일은 보호 경로·개발 루트 외부·하드 링크·UTF-8/제어문자·크기를 검증하고 읽는 동안의 변경도 확인한다. S8이 캡처를 분석하고 기존 항목을 조회한 뒤 `sourceId`와 등록안으로 `projectman intake_preview`를 호출한다. `intake_register` 또는 `/projectman-register <requestId>`의 대화형 확인 전에는 생성하지 않는다. headless 등록은 거부한다. Telegram 승인 UI 전달 여부는 별도 검증하며 확인되지 않으면 웹 터미널/TUI를 사용한다.
- 서버는 기존 콘텐츠 생성의 계층·권한·채널 규칙·생성 감사 경계를 재사용한다. 등록은 채널별 직렬 트랜잭션이며 부모를 잠그고 미리보기의 콘텐츠 지문을 재검증한다. 중간 삽입 실패는 생성·감사를 모두 롤백한다. 같은 요청 ID로 다른 등록안을 보내면 409다.
- S8은 성공 후 모든 항목을 재조회해 계층·자동 실행 꺼짐·승인 필요 설정을 확인한다. 응답 유실/검증 실패는 완료로 보고하지 않고 같은 요청 ID를 보존한다. 네트워크 오류에 쓰기 자동 재시도는 없다.
- 승인 전 원문 캡처와 미리보기는 Pi 세션 브랜치의 custom entry로만 복구한다. 등록된 원문·해시·완료 조건·의존 UID는 Projectman에 보존한다. `intake_get`의 세션 fallback은 미리보기일 뿐 실제 등록 상태가 아니다. 일반 도구 조회/조사 프롬프트에는 대형 원문을 넣지 않는다.
- `intake` 메타데이터와 예약 slug는 일반 생성/수정 API로 위조·변경하지 못한다. 일반 일정·속성 수정은 저장된 속성을 병합하여 원문과 승인 설정을 지우지 않는다. 등록된 항목이 삭제·이동·변경되어 재시도 검증이 실패하면 중단하고 확인하며 자동 재생성하지 않는다.
- `requiresApproval=true`도 기존 승인 태그와 동일하게 `/projectman-approve` 대상이다. 등록 확인은 작업 실행 확인이 아니고, 초기 작업에는 실행 권한·예정 시각·예약 잡을 부여하지 않는다. 의존 관계를 실행 단계에서 자동 처리하는 기능은 이번 범위가 아니다.
- 롤백은 신규 등록을 중지하고 S8 intake 도구/지침을 이전 버전으로 돌린 뒤 PH-CMS 코드를 되돌린다. 신규 테이블·컬럼이 없어 역마이그레이션은 필요 없다. 기존 등록 콘텐츠·원문·상태는 삭제하거나 초기화하지 않는다. 이전 서버에 새 도구를 호출해 404가 나면 중단하고 임의 API로 우회하지 않는다.
- S8 검증: `node --test pi/test/*.test.mjs apps/telegram-gateway/gateway.test.mjs` 및 `git diff --check`. PH-CMS의 전용 `vitest.intake.config.ts`는 비어 있는 일회용 DB만 허용하며 기존 테스트/운영 DB를 reset하지 않는다. fixture 실행 절차는 PH-CMS Projectman README를 참고한다.

## Projectman 지시 잡 운영

- `scheduler`에서 `kind=projectman`, `projectUid`, `intervalMinutes=5`로 생성한다. 대화형 승인 정책은 유지한다. 쉘 잡과 혼용할 수 있다.
- 빈 조회에는 모델·Telegram 호출이 없다. 승인된 읽기 전용 워크/서브워크 1건에 프롬프트 1회만 보내고 시작·결과를 알린다. 미완료는 Projectman 로그와 `ready` 상태를 근거로 다음 실행에서 재개한다.
- 부모·항목의 활성화, 승인·민감 태그, 예정 시각, 저장소 범위를 확인한다. 쓰기·배포 자동 실행 권한을 추가하지 않는다. `review`·`blocked`·`canceled`·`done`은 반복 실행하지 않는다.
- 기존 잡 전환: 데몬을 새 코드로 재시작한 뒤 `node pi/bin/projectman-job.mjs JOB_ID PROJECT_UID`. 작업·결과·활성화 여부·종료 시각은 그대로 두며 원래 스크립트는 롤백용으로 유지한다.
- 롤백은 잡을 일시정지하고 종류·기존 스크립트·주기를 복원한 뒤 코드와 데몬을 되돌린다. 변환된 설정에 이전 데몬 코드를 먼저 적용하지 않는다.
- 모델·프로세스가 끝났다는 이유만으로 완료를 기록하지 않는다. 결과 로그 기록에 실패한 `doing`은 수동 확인하고 복구하며 자동 선점하지 않는다.
- 자세한 제약·복구·알림 정책은 [`pi/SCHEDULER.md`](pi/SCHEDULER.md)를 따른다. S8에 새 CRUD 필드·시스템 지침을 적용하려면 S8도 재시작한다.

## S8 관리 세션과 웹 터미널

```bash
./start-pi.sh --sessions
./start-pi.sh --session main
./start-pi.sh --session main --telegram
npm start --prefix apps/terminal-gateway
```

- 선택한 세션의 Pi와 공유 스케줄러·개발 감독을 같은 창에서 재시작하고 접속 없이 목록만 출력한다. 기본으로 그 세션이 Telegram polling 소유권을 가져온다. `--no-telegram`은 Telegram 없이 실행하며 다른 세션의 연결을 가져오지 않는다. 재시작 제어는 별도 프로세스에서 수행하므로 호출한 Pi가 종료돼도 계속 진행한다.
- 웹에서는 `/s8/terminal`이 기본으로 호스트 셸 `s8-host-shell`에 연결된다. S8 Pi 세션도 선택할 수 있다.
- `셸 열기`는 고정 셸을 생성·재사용한다. 브라우저 연결 해제는 셸을 종료하지 않는다. 모바일 입력은 보조 키 버튼을 사용한다.
- 설치, 네트워크 경계와 복구 절차는 [`apps/terminal-gateway/README.md`](apps/terminal-gateway/README.md)를 따른다.

## tmux 활용

백그라운드에서 Pi와 서비스 창을 준비한 뒤 직접 접속:

```bash
./start-pi.sh
tmux attach-session -t s8-main
```

접속, 분리, 상태 확인, 종료:

```bash
tmux attach-session -t s8-main
# 세션 안에서 Ctrl-b, w로 창 선택, Ctrl-b, d로 분리
tmux has-session -t s8-main
tmux kill-session -t s8-main
```

frontend를 같은 tmux 세션의 별도 창에서 실행하려면 다음을 사용한다.

```bash
tmux new-window -t s8-main -n frontend -c "$PWD" \
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

`./start-infra.sh`는 저장소 루트 `.env`를 Compose에 명시 전달한다. 매번 기존 `s8-infra` 세션의 모든 창을 종료하고 새 창을 만든 뒤 Compose에 `up --build --force-recreate -d`를 실행해 Nginx·KB Browser 컨테이너를 교체한다. 실행 중이던 창 프로세스도 종료되므로 필요한 작업은 먼저 저장한다. frontend도 새 창에서 다시 시작한다. PHCMS 로직은 S8 실행 코드에 포함하지 않는다. 필요하면 `.env`의 `PHCMS_START_COMMAND`에 `cd /home/dev_854/ph-cms && pnpm build && pnpm dev`처럼 실행 명령을 지정하고, 새 `phcms` 창에서 실행한다. 미설정 시 해당 창은 비워 둔다. `NGINX_BIND_IP`는 셸 환경변수가 `.env`보다 우선하며 둘 다 없으면 localhost(`127.0.0.1`)에만 바인딩한다. 웹 터미널 세션 목록에서 `s8-infra`를 선택할 수 있다.

로컬 전용 실행:

```bash
NGINX_BIND_IP=127.0.0.1 \
  docker compose --env-file .env -f infra/nginx/docker-compose.yml up -d --build
```

Tailscale 전용 실행:

```bash
tailscale ip -4
NGINX_BIND_IP=<TAILSCALE_IP> \
  docker compose --env-file .env -f infra/nginx/docker-compose.yml up -d --build
```

상태와 로그:

```bash
docker compose --env-file .env -f infra/nginx/docker-compose.yml ps
docker compose --env-file .env -f infra/nginx/docker-compose.yml logs --tail 100 nginx kb-browser
```

Nginx 설정 검사:

```bash
docker compose --env-file .env -f infra/nginx/docker-compose.yml \
  run --rm --no-deps nginx nginx -t
```

중지:

```bash
docker compose --env-file .env -f infra/nginx/docker-compose.yml down
```

`down`은 서비스를 중단하므로 사용자의 명시적 요청이나 승인 후 실행한다.

## 상태 점검

```bash
./start-pi.sh --version
tmux has-session -t s8-main
curl -fsS http://127.0.0.1:4178/s8/
docker compose --env-file .env -f infra/nginx/docker-compose.yml ps
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

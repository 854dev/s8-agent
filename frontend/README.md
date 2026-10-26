# S8 웹 콘솔

Vite + React + Mantine 기반의 `s8 (scheduler 854)` 웹 프론트엔드다. 기본 경로는 `/s8/`이며, Projectman 작업·인간 검토와 지식베이스·파일 업로드·호스트 터미널을 제공한다.

## 현재 포함 화면

- `/s8/`: PH-CMS 사용자 로그인, 실제 작업 목록·범위 승인·인간 질문·초안 저장·명시적 답변 확정·개발 결과·실행 이력과 패치 조회
  - 워크스페이스 버튼을 선택하면 소속 프로젝트 전체와 7개 상태별 작업 보드를 표시한다. 하위 작업도 해당 프로젝트에 포함하며 프로젝트가 비어 있어도 표시한다.
  - 인간 결정 대기 요약 카드는 한 번 눌러 미해결 질문만 표시한다. 작업 카드는 상세·검토·실행 기록으로 연결한다. 선택한 워크스페이스는 URL에 유지하며 모바일 보드는 가로로 스크롤한다.
- 읽기 전용 지식베이스 브라우저
    - 파일 트리와 lazy folder loading
    - 계획·작업내역 검색과 최근 문서
    - Markdown reader
    - 데스크톱 split view와 모바일 목록/reader 전환
- `/s8/upload`: 파일 선택·드래그 업로드, 결과·오류 표시. `/api/files/upload` 사용
- `/s8/terminal`: xterm.js 기반 호스트 셸·S8 tmux 세션 접속, 세션 전환·재연결, 모바일 보조 키·붙여넣기·전체화면·글자 크기 조절

## 로그인 유지

- 콘솔 서버가 `@ph-cms/client-sdk/core`의 로그인·갱신 API를 사용한다. 브라우저에는 토큰을 JavaScript 응답이나 localStorage로 전달하지 않는다.
- 액세스 토큰은 15분, 리프레시 토큰은 마지막 갱신부터 7일 유효하다. 두 쿠키는 `HttpOnly`, `SameSite=Strict`로 보관하고 HTTPS에서는 `Secure`도 설정한다.
- 페이지 재접속·브라우저 재실행·콘솔 재시작 후에도 유효한 갱신 쿠키가 있으면 로그인을 복원한다. 동시 요청의 갱신은 합치고 사람의 결정 요청은 중복 실행하지 않는다.
- 로그아웃은 두 쿠키를 지운다. 갱신 인증이 만료·무효화되면 다시 로그인하며, 서버 일시 장애는 로그인 만료로 처리하지 않는다.
- 이 기능 적용 전 로그인에는 갱신 쿠키가 없으므로 최초 한 번은 다시 로그인해야 한다.

## 화면 스타일

- 흰색·검은색·중성 회색을 중심으로 Carbon의 White/Gray 10 레이어 원칙을 참고한다.
- `src/index.css`에서 공통 색상 토큰을, `src/main.tsx`에서 Mantine의 글꼴·직각 형태·버튼 색상을 설정한다.
- IBM Plex Sans KR 400·500·600을 `@fontsource/ibm-plex-sans-kr`로 자체 호스팅한다. [글꼴 라이선스](public/fonts/IBM-Plex-Sans-KR-LICENSE.txt)를 포함한다.
- 작업 상태는 제목·숫자·선택 표시로 구분한다. 키보드 포커스와 동작 줄이기 설정을 지원한다.

## 실행

`s8-agent` 루트에서 실행한다.

```bash
npm ci --prefix frontend
npm run dev --prefix frontend -- --host 127.0.0.1 --port 4178
```

로컬 화면은 `http://127.0.0.1:4178/s8/`에서 연다. 다른 장치에서는 Tailscale IP에 바인딩한 라우터를 통해 `http://<Tailscale-IP>/s8/`로 접속한다. 웹 터미널은 호스트 사용자 권한을 가지므로 전체 인터페이스나 공인망에 노출하지 않는다.

- 지식베이스·업로드: `apps/kb-browser`와 라우터 필요
- 터미널: `apps/terminal-gateway`와 tmux 필요
- Projectman: PH-CMS와 `node pi/bin/projectman-console.mjs` 필요. [실행 안내](../README.md) 참고.
- Vite dev/preview는 `/api/projectman`을 `127.0.0.1:8791`로, `/api/terminal`을 `127.0.0.1:8790`으로, 나머지 `/api`를 라우터로 proxy한다. 라우터 주소는 `S8_BIND_IP`·`S8_HTTP_PORT` 환경변수로 받는다. `./start-infra.sh`가 `config.yml`의 `network`에서 넘기며, 직접 실행할 때는 먼저 `eval "$(node pi/bin/s8-config.mjs shell-env)"`를 실행한다. 기본값은 `127.0.0.1:80`이다. 설정 변경 시 frontend도 재시작한다. 이 설정은 브라우저 번들에 포함하지 않는다.
- `./start-infra.sh`는 라우터·KB Browser·frontend·Projectman 콘솔 API·터미널 게이트웨이를 함께 시작한다. 사전에 `pi`, `frontend`, `apps/terminal-gateway`, `apps/kb-browser`의 npm 의존성을 설치한다. 콘솔과 게이트웨이는 `s8-infra`의 `projectman-console`·`terminal-gateway` 창에서 실행된다. PH-CMS는 `config.yml`의 `projectman.startCommand`를 설정한 경우에만 스크립트에서 시작한다. 서비스 기동 중 연결이 실패하면 Projectman·지식베이스의 `연결 다시 시도`, 업로드의 `다시 시도`로 복구한다.
- 라우터의 `/s8/`는 Vite 개발 서버의 HMR WebSocket도 전달한다. Tailscale의 HTTP 접속에서도 결정 요청 ID를 생성할 수 있다.
- backend 실행·접근 제한·복구는 [웹 터미널 운영 문서](../apps/terminal-gateway/README.md)를 참고한다.

## 빌드
```bash
npm run build --prefix frontend
npm run preview --prefix frontend -- --host 127.0.0.1 --port 4178
```

빌드 결과는 `frontend/dist/`에 생성된다. 라우터를 통한 서비스에서는 호스트의 dev/preview 서버가 4178 포트에서 실행되어야 한다.

## 지식베이스 브라우저

지식베이스 화면은 라우터 prefix 뒤의 `/s8/knowledge-base`에서 연다.

```text
http://127.0.0.1/s8/knowledge-base
```

프론트엔드는 같은 origin의 `/api/docs/*`를 사용한다. 지식베이스는 읽기 전용이며 문서 편집 API는 제공하지 않는다. 예약 상태는 별도 스케줄러 런타임에, Projectman 작업·로그는 PH-CMS에 저장된다. Projectman 화면은 실제 작업 상태를 조회한다.

## 터미널 폰트

- Yazi 등의 아이콘은 `public/fonts/SymbolsNerdFontMono-Regular.ttf`를 같은 서버에서 제공한다. 외부 CDN이나 클라이언트의 Nerd Font 설치가 필요 없다.
- Nerd Fonts v3.4.0의 Symbols Only Mono를 사용하며 배포 라이선스는 `public/fonts/LICENSE`에 포함한다.
- 아이콘 폰트는 유니코드 Private Use 영역에만 적용하고, 영문·한글·다른 언어는 운영체제의 고정폭 및 CJK 폰트로 대체한다. 글리프 지원은 클라이언트에 설치된 폰트에 따라 달라진다.
- 폰트 다운로드와 무관하게 셸에 즉시 연결하며, 아이콘 폰트 로드 후 화면 크기와 표시를 갱신한다. 다운로드 실패 시 시스템 폰트를 유지하고, 셸 프로세스나 서버 설정은 변경하지 않는다.

## 테스트와 lint

`s8-agent` 루트에서 실행한다.

```bash
npm run test:run --prefix frontend
npm run lint --prefix frontend
npm run build --prefix frontend
```

## 현재 제약

- 예약 CRUD는 Pi의 `scheduler` 도구, 예약 정지·재개·배치 중단은 Telegram `/jobs`를 사용한다.
- Projectman은 사용자 로그인과 서버 권한 검사로 결정 권한을 확인한다. KB·업로드·터미널의 기존 Tailscale ACL 경계는 유지한다. 웹 KB 문서 편집은 제공하지 않는다.
- 여러 터미널 접속자는 같은 셸·세션의 입력과 화면 크기를 공유한다. 브라우저를 닫아도 tmux 세션은 유지된다.
- 폰트 글리프·모바일 키보드·전체화면 동작은 실제 클라이언트 환경에서도 확인해야 한다.

# s8 인프라 구성 정책

이 문서는 `s8-agent`가 소유하는 실행 환경과 네트워크 경계를 정의한다.

## 범위

- 프로젝트 로컬 Pi 실행 환경
- Pi tmux 세션
- frontend preview
- Node 라우터와 지식베이스 API(KB Browser)
- Tailscale 사설 접근

## Canonical 경로

```text
dev_854/
├── 854_md/                   # 지식과 프로젝트 문서
│   └── AGENTS.md
└── s8-agent/                # 에이전트 설정과 실행 코드
    ├── apps/terminal-gateway/ # 호스트 PTY/WebSocket 서비스
    ├── apps/kb-browser/      # 읽기 전용 문서 API
    ├── frontend/             # 운영 콘솔
    ├── infra/router/         # 경로별 proxy(Node)
    ├── pi/                   # Pi 버전, 공유 설정, extension, skill
    ├── .pi-runtime/          # Pi 인증정보, 세션, 캐시
    ├── .s8-runtime/          # 로그와 업로드 등 로컬 상태
    ├── start-general-agent.sh
    ├── start-manager-agent.sh
    ├── start-worker-agent.sh
    ├── s8.sh
    └── start-infra.sh
```

## 서비스 토폴로지

```text
Tailscale 장치
  -> 호스트 Tailscale IP:80 (network.bindIp:httpPort)
  -> Node 라우터 (s8-infra:router 창)
      -> /s8/        -> 127.0.0.1:4178
      -> /api/docs/  -> 127.0.0.1:8787 (KB Browser)
      -> /api/terminal/ -> 127.0.0.1:8790
      -> /api/projectman/ -> 127.0.0.1:8791
      -> /api/v2/    -> 127.0.0.1:8000 (PH-CMS API와 관리자 UI)
      -> /health     -> 라우터 자체 응답

호스트
  -> tmux: s8-main -> 프로젝트 로컬 Pi CLI
  -> tmux: s8-infra -> 라우터, KB Browser, frontend:4178, 콘솔 API, 터미널 게이트웨이, PH-CMS(선택)
```

## 실행 환경 분리

- Git에 포함: Pi 버전, npm 잠금 파일, `pi/`의 검토된 설정·extension·skill
- Git에서 제외: `.pi-runtime/` 전체, 로그, PID, 업로드. 기존 `.pi/`도 계속 제외한다.
- Pi 에이전트 디렉터리: `<s8-agent>/.pi-runtime`
- Pi 작업 디렉터리: `s8-config.yml`의 `kbRoot`(기본 `../854_md`)
- 비밀값(서비스 키·봇 토큰)은 `.env`, 그 밖의 장비별 설정은 `s8-config.yml`에 둔다. 둘 다 Git에서 제외한다.
- 에이전트 실행 스크립트(`start-*-agent.sh`)는 런타임에 `pi/settings.json` 심볼릭 링크를 만들고 extension, skill, 시스템 지침은 `pi/`에서 명시적으로 로드한다. 설정 변경과 패키지 선언은 공유 설정에 반영된다.
- 보호 extension은 `.pi/`, `.pi-runtime/`와 비밀 경로에 대한 에이전트 도구 접근을 차단한다.

## 네트워크 정책

```bash
# s8-config.yml: network.bindIp: 100.120.50.80
./start-infra.sh
```

- Tailscale 전용 운영에서는 실제 Tailscale IPv4를 명시한다.
- localhost 앞단만 사용할 때는 `127.0.0.1`을 지정한다.
- `network.bindIp`가 없으면 `127.0.0.1`에만 바인딩하고 `0.0.0.0`은 설정에서 거부한다. 원격 운영에서는 실제 Tailscale IPv4를 지정하며 전체 인터페이스로의 기본 바인딩은 없다.
- `0.0.0.0`은 모든 인터페이스에 노출되므로 웹 터미널 운영에 사용하지 않는다.
- 웹 터미널은 별도 인증 없이 호스트 사용자 권한을 제공한다. Tailscale ACL과 전용 바인딩을 접근 권한 경계로 사용한다. Host/Origin 검사로 다른 웹사이트의 연결을 차단한다.
- 쓰기 API는 인증과 승인 정책 없이 추가하지 않는다.

## 지식베이스 공개 경계

허용:

- 일반 Markdown 문서

차단:

- `.pi/**`
- `.pi-runtime/**`
- `.s8-runtime/**`
- `.git/**`
- `SECRET/**`, `secret/**`
- `node_modules/**`
- 경로 탈출 요청

## 변경 책임

- Pi 버전과 프로젝트 동작: `pi/`
- Pi 장비별 런타임: `.pi-runtime/`
- Pi 실행: `s8.sh`
- 통합 인프라 실행: `start-infra.sh`
- tmux: 표준 `tmux` 명령
- 라우터 경로: `infra/router/router.mjs`
- API: `apps/kb-browser/`
- frontend: `frontend/`
- 운영 절차: `OPERATIONS.md`

## 변경 규칙

- extension은 전체 시스템 권한으로 실행되므로 코드 리뷰 없이 외부 extension을 추가하지 않는다.
- 패키지 버전은 정확히 고정하고 잠금 파일을 커밋한다.
- 외부 공개, 삭제, 포트, 인증 정책 변경은 사용자 승인을 받는다.
- `s8-infra` 세션 종료와 `start-infra.sh` 재실행은 서비스 중단을 유발하므로 명시적 승인 없이 실행하지 않는다.
- 인프라 변경 후 shell 문법과 관련 테스트를 검증한다.

## Verify

```bash
test -f pi/settings.json
test -f pi/package-lock.json
bash -n start-general-agent.sh start-manager-agent.sh start-worker-agent.sh
bash -n s8.sh
bash -n start-infra.sh
node --test pi/test/router.test.mjs
```

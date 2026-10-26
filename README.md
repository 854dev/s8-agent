# S8 Agent

`854_md` 지식베이스를 쓰는 개인용 AI 작업 오케스트레이터와 운영 콘솔이다. 매니저 에이전트가 대화로 개발 요청을 정리해 Projectman(PH-CMS) 작업으로 등록하고, 사람이 계획을 확정하면 워커 에이전트가 지정한 작업 디렉터리에서 자율적으로 구현·검증·보고한다. 지식과 에이전트 설정은 `854_md`, `s8-agent` 저장소로 나눈다.

```text
dev_854/
├── 854_md/       # 지식베이스(매니저 작업 위치)
├── s8-agent/     # 이 저장소: 에이전트 설정·실행 코드·콘솔
└── ph-cms/       # Projectman API·MCP 서버
```

문서는 이 README 하나다. 에이전트 작업 지침은 [`AGENTS.md`](AGENTS.md), 역할별 지침은 `agents/<모드>/SYSTEM.md`, 예약 상세는 [`pi/SCHEDULER.md`](pi/SCHEDULER.md), 하위 앱은 각 디렉터리의 README에 있다.

## 목차

- [빠른 시작](#빠른-시작)
- [설정 파일](#설정-파일)
- [실행 스크립트](#실행-스크립트)
- [에이전트 모드](#에이전트-모드)
- [개발 흐름](#개발-흐름)
- [상주 워커](#상주-워커)
- [인프라와 웹 콘솔](#인프라와-웹-콘솔)
- [Telegram](#telegram)
- [스케줄러](#스케줄러)
- [작업요청 등록](#작업요청-등록)
- [Projectman 리소스와 멈춘 실행](#projectman-리소스와-멈춘-실행)
- [PH-CMS 연결](#ph-cms-연결)
- [상태 점검과 장애 분리](#상태-점검과-장애-분리)
- [보안과 변경 규칙](#보안과-변경-규칙)
- [코드 위치](#코드-위치)
- [에이전트 메시지 통신](#에이전트-메시지-통신)
- [다른 장비에서 재현](#다른-장비에서-재현)
- [검증](#검증)

## 빠른 시작

요구 사항:

- Node.js 22.19.0 이상과 npm
- tmux(통합 실행·지속 실행·웹 터미널)
- Bash(예약 셸 스크립트. Windows는 Git Bash 등)
- Projectman을 쓰려면 실행 중인 PH-CMS와 DB, 에이전트 서비스 키
- 다른 장치에서 웹 콘솔에 접속하려면 Tailscale

```bash
cd /path/to/s8-agent
npm ci --ignore-scripts --prefix pi
npm ci --prefix frontend
npm ci --prefix apps/terminal-gateway
npm ci --prefix apps/kb-browser
cp -n .env.example .env
cp -n config.example.yml config.yml   # kbRoot 등을 이 장비에 맞게 고친다
./start-infra.sh                            # 라우터·KB Browser·frontend·콘솔 API·웹 터미널
./s8.sh --mode project                      # 매니저·스케줄러·상주 워커
tmux attach-session -t s8-main
```

Pi 창이 열리면 `/login`으로 이 장비의 모델 인증을 설정한다. 인증정보와 세션은 `.pi-runtime/`에 저장되며 Git과 에이전트 도구의 접근 대상에서 제외된다. 예전 `.pi/`의 인증정보는 자동으로 옮기지 않는다. 공유 설정의 원본은 `pi/settings.json`이고 런타임은 이 파일을 링크로 참조한다. provider·model은 이 파일을 기준으로 하며 Pi에서 바꿀 수 있다. 워커도 같은 `.pi-runtime/` 인증을 쓴다.

웹 콘솔은 `http://<network.bindIp>/s8/`(로컬은 `http://127.0.0.1:4178/s8/`)에서 PH-CMS 사용자 계정으로 로그인한다.

## 설정 파일

설정은 두 파일로 나눈다. 둘 다 Git에 포함되지 않으며, 처음 설정하는 장비에서만 예시를 복사한다.

| 파일 | 내용 | LLM 접근 |
| --- | --- | --- |
| `.env` | `PHCMS_ACCESS_TOKEN`(Projectman 에이전트 서비스 키), `TELEGRAM_BOT_TOKEN`, `CLINE_API_KEY` | 읽기 차단, 에이전트 bash에 넘기지 않음 |
| `config.yml` | `kbRoot`, `projectman.apiUrl`·`startCommand`, `network.bindIp`·`httpPort`, `workers`, `telegram` ID, `publicUrl` | 읽을 수 있음 |

- 항목의 의미와 기본값은 [`.env.example`](.env.example)과 [`config.example.yml`](config.example.yml)의 주석에 있다. `node pi/bin/s8-config.mjs show`로 검증한 값을 확인한다.
- `config.yml`에 모르는 키가 있으면 시작하지 않는다. 예전 `.env`의 `S8_KB_ROOT`·`PHCMS_API_URL`·`NGINX_*`·`PHCMS_START_COMMAND`·`S8_WORKER_ID`·Telegram ID 변수와 예전 `worker-entries`·`worker-communicator` 키, 이전 통신 서버의 `communication.server`·`nodeId`·`credentialsFile`·`managerUrl`은 읽지 않으므로 직접 옮기거나 지운다.
- `kbRoot`의 상대 경로는 이 저장소 기준이고 앞의 `~/`는 홈 디렉터리다.
- 모든 모드의 실행기는 시작할 때 `.env`를 읽고 `config.yml` 값을 하위 프로세스에 넘긴다. 같은 이름의 환경변수가 셸에 있어도 설정 파일이 우선한다.
- 설정을 바꾸면 해당 프로세스(매니저, 스케줄러, `start-infra.sh`)를 다시 시작해야 반영된다.

### 80번 포트 허용 (리눅스)

라우터는 일반 사용자 권한의 Node 프로세스로 `network.httpPort`(기본 80)를 연다. 리눅스는 기본으로 1024 미만 포트를 일반 사용자에게 막으므로, 장비마다 한 번 아래 명령으로 80번부터 허용한다. 설정은 재부팅 후에도 유지된다. macOS는 이 제한이 없어 필요 없다.

```bash
echo 'net.ipv4.ip_unprivileged_port_start=80' | sudo tee /etc/sysctl.d/90-s8-router-port.conf
sudo sysctl --system
sysctl net.ipv4.ip_unprivileged_port_start   # 80이면 적용됨
```

- 허용하지 않은 상태로 `./start-infra.sh`를 실행하면 이 명령을 안내하고 아무것도 바꾸지 않은 채 종료한다.
- 이 설정은 장비 전체에 적용된다. 이 장비의 모든 사용자 프로세스(에이전트가 실행한 명령 포함)가 80번 이상 포트를 열 수 있으므로, 여러 사람이 쓰는 장비에서는 적용 전에 검토한다.
- 되돌리기: `sudo rm /etc/sysctl.d/90-s8-router-port.conf && sudo sysctl -w net.ipv4.ip_unprivileged_port_start=1024`

## 실행 스크립트

스크립트는 경로를 스크립트 위치 기준으로 계산하므로 다른 디렉터리에서도 실행할 수 있다.

| 스크립트 | 역할 |
| --- | --- |
| `start-general-agent.sh` | 범용 에이전트 하나를 이 터미널에서 실행 |
| `start-manager-agent.sh` | 매니저 에이전트 하나를 이 터미널에서 실행 |
| `start-worker-agent.sh` | 워커 에이전트 하나를 이 터미널에서 실행 |
| `s8.sh` | tmux 런타임(매니저·스케줄러·상주 워커) 시작과 작업 실행 명령 |
| `start-infra.sh` | `s8-infra` 세션(라우터·KB Browser·frontend·콘솔 API·웹 터미널·PH-CMS) 재시작 |

```bash
./start-general-agent.sh                        # 실행 위치에서 파일·셸·코드 작업
./start-general-agent.sh --cwd /path/to/work
./start-general-agent.sh --print --model <모델>  # 비대화형 실행
./start-manager-agent.sh --telegram             # KB 저장소에서 Projectman 관리, Telegram 연결
./start-worker-agent.sh --uid <UID>             # 실행 위치 저장소에서 UID 작업 claim·수행·보고

./s8.sh --mode project                          # 매니저·스케줄러·상주 워커
./s8.sh --mode general --cwd /path/to/work      # 범용 에이전트(프로젝트 서비스 없음)
./s8.sh --continue                              # 최근 대화 이어가기
./s8.sh --session work                          # s8-work 세션으로 시작
./s8.sh --no-scheduler                          # 스케줄러 제외
./s8.sh --telegram take | --telegram off        # Telegram 연결 이전·해제
./s8.sh --sessions                              # S8 세션 목록
./s8.sh work <UID>                              # 승인된 작업의 워커를 s8-workers:<UID> 창에 실행
./s8.sh finish <UID> --run-id <UUID> --confirm-stopped   # 멈춘 실행을 실패로 마무리
./s8.sh service scheduler                       # 예약 데몬 전경 실행
./s8.sh service worker <id>                     # 상주 워커 루프 전경 실행
./s8.sh --help
```

`s8.sh` 동작:

- project 모드는 먼저 `s8-infra` 세션의 서비스 창(router, kb-browser, frontend, projectman-console, terminal-gateway, `projectman.startCommand`를 설정했으면 phcms)이 실행 중인지 확인한다. 창이 없거나 서비스가 종료돼 셸만 남은 창이 있으면 `./start-infra.sh`로 먼저 시작하라고 안내하고 아무것도 바꾸지 않은 채 종료한다. general 모드는 확인하지 않는다.
- 런타임을 시작하면 `s8-infra`를 뺀 현재 tmux 서버의 모든 세션을 종료한 뒤 선택한 세션을 새로 만든다. 다른 S8 세션, 워커, 웹 터미널 호스트 셸(`s8-host-shell`), 개인 tmux 세션도 종료된다. `--sessions`, `work`, `finish`, `service`, 도움말은 세션을 종료하지 않는다.
- 터미널에서 모드를 생략하면 `project` / `general`을 고른다. 자동화는 `--mode`를 명시한다. `--manager`는 `--mode project`의 별칭이다.
- project 모드는 `s8-main` 세션에 `shell`·`pi`·`scheduler` 창을 만들고 `s8-workers` 세션에 상주 워커 창을 띄운다. 작업 디렉터리는 `kbRoot`다. general 모드는 `s8-general` 세션에서 범용 에이전트(`start-general-agent.sh`)를 KB·Projectman 설정과 서비스 없이 실행하며, 대화 이력은 세션·작업 디렉터리별로 나눈다.
- 자동 접속하지 않고 창 목록만 출력한다. 웹 터미널에서 세션을 고르거나 `tmux attach-session -t s8-main`으로 접속한다.
- 재시작 제어는 터미널과 분리된 프로세스가 끝까지 수행한다. 현재 Pi 안에서 `s8.sh`를 호출해 호출자가 종료돼도 새 Pi와 Telegram 연결을 올린다. 결과는 `.s8-runtime/runtime-restarts/`에 남는다.
- 런타임을 다시 시작하면 작업 중인 워커 창도 종료된다. 진행 중이던 작업은 `./s8.sh work <UID>`로 같은 작업 디렉터리에서 이어간다.
- tmux 밖에서 살아 있는 서비스는 중복 실행하지 않는다. 종료된 PID의 남은 잠금만 정리한다. `--no-scheduler`는 그 호출의 자동 시작만 뺀다.
- 패키지 관리 명령, `--version`, `--print`는 `start-*-agent.sh`로 실행한다.
- 서비스 창은 `tmux attach -t s8-main` 후 `Ctrl+B`, `W`로 고르고 `Ctrl+C`로 끈다. 종료된 창은 로그 확인을 위해 남는다. `Ctrl+B`, `D`는 접속만 해제한다.

## 에이전트 모드

모드별 도구·확장·스킬·시스템 지침은 `agents/<모드>/profile.json`에 있다. Pi의 확장·스킬 자동 발견은 끄고 프로필의 항목만 명시적으로 로드한다. 실행 인자로 도구 허용 목록을 바꿀 수 없다.

| 모드 | 작업 위치 | 도구 | 스킬 |
| --- | --- | --- | --- |
| 범용 | 실행 위치(`--cwd`) | read, bash, edit, write, grep, find, ls | `projectman`, `ponytail`, `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `s8-self-review` |
| 매니저 | `kbRoot` | projectman, kb, scheduler, run_worker, set_worker_mode, read, bash, edit, write, grep, find, ls | `projectman`, `projectman-manager`, `s8-requirements`, `s8-task-plan`, `s8-plan-review`, `s8-operations` |
| 워커 | 작업 디렉터리 | projectman, read, bash, edit, write, grep, find, ls | 범용 스킬 + `projectman-worker` |

- Projectman 사용법은 [공통](pi/skills/projectman/SKILL.md)·[매니저](pi/skills/projectman-manager/SKILL.md)·[워커](pi/skills/projectman-worker/SKILL.md) 스킬로 관리한다. 시스템 프롬프트는 역할·자율성·협업 원칙을 정하고 도구 사용법은 해당 스킬을 참고한다. 범용은 공통, 매니저와 워커는 공통·역할별 스킬을 프로필에서 로드한다. 스킬을 제공해도 범용에 Projectman 도구·인증이 추가되지는 않는다. 변경한 스킬·시스템 프롬프트는 해당 Pi 프로세스를 재시작하면 적용된다.
- 범용 모드는 Projectman 없이 쓰는 즉석 개발용이다. 모델 API 키를 공유하도록 `.env`를 읽는다. `s8-self-review`는 사용자에게 완료를 알리기 전 자기 검토로 쓴다.
- 매니저는 일반 대화·글쓰기·파일·Bash 작업을 직접 처리하고, 개발 요청은 Projectman 작업으로 만들어 워커에게 맡긴다. 이 구분은 시스템 지침에 따른 규칙이며 실행 격리 경계가 아니다.
- 워커는 task·subtask UID 하나를 claim하고 결과를 보고한다. 파일·명령 도구는 claim 전·보고 후에도 사용할 수 있다. 작업 순서와 범위는 시스템 프롬프트와 매니저 지시로 조정한다. `--uid` 없이 실행하면 "uid xxx 의 업무를 수행해라"처럼 대화로 지시한다.
- 모든 모드의 bash에는 토큰·비밀번호 환경변수를 넘기지 않는다. 같은 사용자 권한으로 실행되므로 완전한 격리는 아니다.
- 외부 스킬은 `pi/skills/vendor/`에 원본 그대로 두고 출처·버전은 `SOURCE.md`, 라이선스는 `LICENSE`에 있다. S8 규칙과 다른 지시(사람에게 묻기, 커밋 등)는 역할 `SYSTEM.md`가 우선한다.
- `/restart`로 종료하면 최근 대화로 다시 시작한다.

## 개발 흐름

1. 등록: 사용자가 요청하면 매니저가 기존 워크스페이스·프로젝트를 조회해 task·subtask를 만든다. 신규 작업은 `todo`(일 시작 전)다.
2. 사전 검토: 매니저가 원문·코드·지침을 보고 요구 충돌·누락·검증 계획을 사용자와 확인한다. 확정 내용을 `delegate`로 계획(spec)에 쓰고 `preflight_review`로 작업의 `s8Preflight`에 기록한다. 콘솔은 이 기록이 현재 작업·spec과 일치해야 승인을 허용한다.
3. 승인: 사람이 콘솔에서 최종 계획 버전을 확인하고 `최종 계획 확정 · 실행`을 누른다. 매니저가 서비스 키로 대신 확정하지 않는다.
4. 실행: 상주 워커·매니저의 `run_worker`·`./s8.sh work <UID>`가 작업의 `repoPath` 디렉터리에서 직접 워커를 시작한다. 없는 디렉터리는 만든다. Git 초기화·저장소 최상위 경로·worktree·커밋·원격 저장소는 요구하지 않는다. 같은 실행은 원래 claim 요청으로 재개한다.
5. 수행: 작업 범위·파일·명령·Git 사용·의존 결과 반영·검증·완료 여부는 워커가 시스템 프롬프트와 매니저 지시에 따라 판단한다. claim 전·보고 후·임시 조사에서도 파일·명령 도구를 차단하지 않는다. Projectman 서버의 claim·report 상태 규칙은 그대로 적용된다. 서버는 `completed` 보고의 실패한 검증·미완료 항목·실행 오류를 허용하지 않으며 이 저장소의 변경만으로 그 서버 규칙은 바뀌지 않는다.
6. 보고: 보고는 `.s8-runtime/runs/<runId>/outbox.json`에 먼저 남긴 뒤 Projectman(review 상태), 매니저 수신함, Telegram으로 전달한다. 전달 실패분은 매니저가 15초마다 다시 보낸다. claim·보고 요청은 요청 ID를 고정해 재시도해도 한 번만 반영된다. 다른 장비 워커의 보고는 매니저가 15초마다 Projectman에서 끝난 실행을 찾아 수신함에 넣고 Telegram을 보낸다. 같은 실행은 수신함에 먼저 넣은 쪽만 Telegram을 보낸다. 매니저가 처음 실행되기 전에 끝난 실행은 옮기지 않는다(`.s8-runtime/manager-runs-since.json`). 원격 워커 장비에는 Telegram을 설정하지 않는다.
7. 검토와 완료: 매니저가 결과와 검증 근거를 보고 `review_result`를 남긴다. 사용자는 Telegram 링크나 콘솔에서 결과를 보고 선택적으로 검토의견을 적어 `검토의견 제출 · 작업 완료`를 누른다. 작업은 done이 되고 의존 작업이 실행 가능해진다.
8. 후속: 매니저가 검토의견을 보고 추가 조치 없음, 질문, 새 작업 중 하나를 고른다. 새 작업은 원본 UID와 의견 참조를 남기고 원본을 선행 작업으로 지정하고 매니저가 필요한 결과 반영을 지시한다. 새 작업도 별도로 승인받는다. 재작업 상태나 자동 실행은 없다.

- 변경은 실제 작업 디렉터리에 남는다. 실행기는 Git index·브랜치·커밋·원격을 조작하거나 패치를 자동 생성하지 않는다. 변경 파일 목록은 워커가 보고하며 같은 디렉터리의 동시 수정은 매니저가 조정한다.
- 실행 기록(claim·보고 요청, 전달 결과)은 `.s8-runtime/runs/<runId>/`에 남고 콘솔에서 본다. 모델 내부 추론과 인증정보는 기록하지 않는다.
- 완료 요청 전에 `.s8-runtime/completion-reviews/`에 전달 기록을 남긴다. 응답이 유실되면 매니저 polling이 서버 완료 이력을 확인해 전달을 복구한다. 같은 의견이 두 번 전달될 수 있어 매니저는 같은 참조의 후속 작업을 먼저 확인한다.
- PH-CMS는 수정하지 않는다. `workflowVersion: 2`, `atomicClaims: true`, `idempotentReports: true` 계약을 쓴다.

`start-worker-agent.sh`도 지정된 실행 위치에서 직접 작업한다. 보고는 같은 경로로 전달되지만 매니저와 콘솔은 그 워커 프로세스 자체를 알지 못한다.

## 상주 워커

`config.yml`의 `workers`에 워커를 적으면 `./s8.sh`(project 모드)가 항목마다 `s8-workers:worker-<id>` 창에 워커 루프를 띄운다. 루프는 모델을 호출하지 않는 Node 프로세스다. 작업을 맡으면 `s8-workers:<UID>` 창에 워커 에이전트를 띄우고, 보고가 끝나면 다음 작업으로 넘어간다. 한 워커는 한 번에 작업 하나만 한다.

```yaml
workers:
  - id: dev-1
    mode: active
  - id: dev-2
    mode: passive
```

| 모드 | 동작 |
| --- | --- |
| `active` | 지시가 없으면 ready 작업 중 배정이 없거나 자기에게 배정되고 선행 작업이 끝난 것을 15초마다 찾아 맡는다 |
| `passive` | 콘솔의 `이 워커에게 지시`나 매니저의 `run_worker`(workerId 지정)로 지시해야 맡는다 |
| `paused` | 새 작업을 맡지 않는다. 지시는 쌓아 두고 진행 중인 작업은 끝까지 기다린다 |

- 모드는 실행 중에 콘솔(작업과 결정 화면 위쪽의 상주 워커)이나 매니저(`set_worker_mode`)로 바꾼다. 바꾼 모드는 `.s8-runtime/workers/<id>/mode.json`에 남아 재시작해도 유지되며, 콘솔의 `설정값으로 되돌리기`로 지운다.
- 지시는 active·passive 모두 받으며 ready 작업 찾기보다 먼저다. 시작하지 못한 지시(ready가 아님, 다른 워커 배정 등)는 버리고 콘솔에 최근 시작 실패로 표시한다.
- active 워커가 하나라도 있으면 매니저는 ready 작업 알림을 받지 않는다.
- 워커 ID는 claim 기록과 `spec.assignee`에 쓰인다. 특정 워커에만 맡기려면 계획의 `assignee`에 워커 ID를 넣는다.
- 보고 후에도 에이전트 창은 남아 결과를 확인하거나 이어서 대화할 수 있다. 끝난 창의 Pi는 대기 상태로 남으므로 필요 없으면 창에서 종료하거나 `tmux kill-window -t s8-workers:<UID>`로 닫는다. `run_worker`나 `./s8.sh work`로 띄운 창도 같다.
- 워커 에이전트가 보고 없이 종료되면 루프는 다음 작업으로 넘어가고 기록만 남긴다. 멈춘 실행은 [멈춘 실행 마무리](#projectman-리소스와-멈춘-실행)로 정리한다.
- 같은 워커 루프는 하나만 뜬다(`.s8-runtime/workers/<id>/owner.lock`). 설정에서 뺀 워커의 루프는 다음 `./s8.sh` 때 멈춘다.

## 인프라와 웹 콘솔

### start-infra.sh

`./start-infra.sh`는 `s8-infra` 세션의 모든 창을 종료하고 아래 창을 새로 만든다. 실행 중이던 창 프로세스도 종료되므로 필요한 작업은 먼저 저장한다. `config.yml`의 `kbRoot`·`network`는 비밀값 없는 환경변수(`S8_KB_ROOT`, `S8_BIND_IP`, `S8_HTTP_PORT`)로 넘긴다.

| 창 | 프로세스 | 주소 |
| --- | --- | --- |
| `router` | Node 라우터 `infra/router/router.mjs` | `network.bindIp:httpPort` |
| `kb-browser` | 지식베이스·업로드 API `apps/kb-browser` | `127.0.0.1:8787`, 업로드는 `.s8-runtime/data/uploads` |
| `frontend` | Vite 개발 서버 | `127.0.0.1:4178` |
| `projectman-console` | 콘솔 API `pi/bin/projectman-console.mjs` | `127.0.0.1:8791` |
| `terminal-gateway` | 웹 터미널 backend | `127.0.0.1:8790` |
| `comm-center` | 에이전트 통신 중계 `apps/comm-center`(`apps/comm-center/.env`가 있는 경우만) | `COMM_CENTER_HOST:PORT`, 기본 `127.0.0.1:8090` |
| `phcms` | `projectman.startCommand`(설정한 경우만) | PH-CMS `127.0.0.1:8000` |

- Docker는 쓰지 않는다. 리눅스에서는 먼저 [80번 포트 허용](#80번-포트-허용-리눅스)을 한 번 적용한다.
- 직접 실행할 때는 먼저 `eval "$(node pi/bin/s8-config.mjs shell-env)"`로 설정을 셸에 가져온다.
- 로그는 각 창에서 본다. 웹 터미널 세션 목록에서 `s8-infra`를 고를 수 있다.

### 라우터와 네트워크

```text
Tailscale 장치
  -> network.bindIp:httpPort (기본 80)
  -> Node 라우터 (s8-infra:router)
      /health             라우터 자체 응답
      /s8/                127.0.0.1:4178 (Vite HMR WebSocket 포함)
      /api/docs/, /api/files/upload   127.0.0.1:8787
      /api/terminal/      127.0.0.1:8790 (WebSocket 포함)
      /api/projectman/    127.0.0.1:8791
      /api/v2/            127.0.0.1:8000 (PH-CMS API와 관리자 UI)
```

- 그 밖의 경로는 404다. 지식 문서를 정적 파일로 직접 공개하지 않는다. 요청 본문은 200MB까지 받는다. 경로 상세는 [`infra/router/README.md`](infra/router/README.md)에 있다.
- `network.bindIp`가 없으면 `127.0.0.1`에만 바인딩한다. Tailscale로 접속하려면 `tailscale ip -4`로 확인한 주소를 넣는다. `0.0.0.0`과 `::`는 설정에서 거부한다.
- 웹 터미널은 별도 인증 없이 호스트 사용자 권한을 준다. Tailscale ACL과 전용 바인딩이 접근 경계다. 터미널 게이트웨이는 Host·Origin을 검사해 다른 웹사이트와 Tailscale·localhost가 아닌 주소의 연결을 막는다.
- 쓰기 API는 인증과 승인 정책 없이 추가하지 않는다.

### 지식베이스 공개 경계

KB Browser는 일반 Markdown 문서만 제공한다. `.pi/`, `.pi-runtime/`, `.s8-runtime/`, `.git/`, `SECRET/`, `secret/`, `node_modules/`와 경로 탈출 요청은 막는다.

### Projectman 콘솔

웹 콘솔(`/s8/`)의 작업과 결정 화면이다. PH-CMS 사용자 계정으로 로그인하며 사람의 결정에 에이전트 서비스 키를 쓰지 않는다. 로그인·토큰 갱신은 콘솔 서버가 처리한다. 15분짜리 액세스 토큰은 HttpOnly 리프레시 쿠키로 자동 갱신하고, 갱신 토큰은 마지막 발급부터 7일 유효하다.

- 위쪽에 상주 워커 목록과 모드 버튼이 있다.
- 워크스페이스를 고르면 소속 프로젝트와 상태별 보드(일 시작 전, 실행 대기, 실행 중, 대기, 결과 검토, 완료, 취소)를 본다. 하위 작업은 같은 프로젝트에 표시한다.
- 인간 결정 대기 카드를 누르면 미해결 질문만 모아 본다. 답변 저장은 초안이고, `답변 확정 · 계획 반영` 후 매니저가 계획에 반영해야 다시 실행된다.
- 작업 상세에서 원래 요청, 계획, 결과와 검증, 실행 기록(페이지 단위), 검토용 패치를 본다. ready 작업은 `이 워커에게 지시`로 상주 워커에게 맡긴다.
- 워크스페이스·프로젝트·작업·하위 작업을 만들고 고치고 지운다. 자세한 규칙은 [Projectman 리소스와 멈춘 실행](#projectman-리소스와-멈춘-실행)에 있다.
- `start-infra.sh` 없이 띄울 때는 `node pi/bin/projectman-console.mjs`와 `npm run dev --prefix frontend -- --host 127.0.0.1 --port 4178`(또는 `build` 후 `preview`)를 실행한다. frontend 상세는 [`frontend/README.md`](frontend/README.md)에 있다.

### 웹 터미널

- `/s8/terminal`은 기본으로 호스트 셸 `s8-host-shell`에 접속한다. 같은 사용자 tmux 서버의 모든 세션(PH-CMS, 스케줄러, 워커, Pi)을 골라 제어할 수 있다. tmux 밖의 서비스는 호스트 셸에서 제어한다.
- `셸 열기`는 고정 셸을 만들거나 재사용한다. 브라우저 연결을 끊어도 셸은 남는다.
- 글자 크기, 전체화면, 모바일 보조 키·붙여넣기를 지원한다. Pi의 파일 보호 확장은 직접 터미널 입력을 제한하지 않는다.
- 설치와 복구는 [`apps/terminal-gateway/README.md`](apps/terminal-gateway/README.md)에 있다.

## Telegram

봇 토큰은 `.env`의 `TELEGRAM_BOT_TOKEN`, 사용자·그룹 ID와 알림 대상은 `config.yml`의 `telegram`에 둔다. 예전 `~/.pi/agent/telegram.json`과 ID 환경변수(`TELEGRAM_ALLOWED_*`, `S8_SCHEDULE_TELEGRAM_CHAT_ID`)는 읽지 않는다.

```yaml
telegram:
  allowedUserIds:
    - "123456789"
  allowedGroupIds:
    - "-1001234567890"
  scheduleChatId: "123456789"
publicUrl: https://<호스트>/s8/
```

- 개인 채팅은 `from.id`가 허용 사용자 목록에, 그룹은 `chat.id`가 허용 그룹 목록에 있어야 한다. 허용 그룹의 모든 참여자가 봇을 쓸 수 있으므로, 권한이 과하면 개인 사용자 ID만 쓴다. 그룹 전체 메시지를 받으려면 BotFather의 privacy mode를 확인한다.
- 빈 허용 목록은 접근을 막는다. `scheduleChatId`는 허용 목록에 있는 ID여야 하며 `null`이면 알림을 보내지 않는다. 작업 알림의 링크는 `publicUrl`을 쓴다. 대상이나 URL이 없으면 알림을 미전송 상태로 보존한다. Telegram 오류는 완료 처리를 막지 않는다.
- 설정을 바꾸면 Telegram 연결 세션과 스케줄러를 재시작한다.
- `./s8.sh`를 터미널에서 실행하면 현재 연결 세션을 보여 주고 현재 연결 유지 / 여기로 가져오기를 고른다. `--telegram take`는 이 세션으로 연결을 옮기고 `--telegram off`는 이 세션만 끈다(`--telegram`, `--no-telegram`은 별칭). 비대화형 실행에서 생략하면 project는 연결, general은 꺼짐이다.
- TUI의 `/telegram`은 상태와 선택 메뉴, `/telegram take`·`/telegram off`는 즉시 이전·해제다. 연결 순서는 명시적인 take 시점을 따른다. off하면 대기 중인 다른 세션이 연결을 이어받는다. 설정은 Pi 재시작과 전체 재시작에도 유지된다.
- 첫 메시지를 보낸 허용 채팅에만 터미널을 연결한다. 연결된 채팅은 터미널과 같은 대화와 도구 진행을 공유한다.
- 명령: `/help`, `/status`(토큰 누계 포함), `/abort`, `/new`, `/model`, `/restart`, `/restart all`, `/jobs`. 키보드 버튼으로도 쓸 수 있다.
- `/restart`는 같은 실행 옵션으로 Pi만 다시 열고 대화와 연결을 이어간다. `/restart all`(키보드 `전체 재시작`)은 모델 호출 없이 분리된 제어 프로세스가 작업 실행기 정리, `start-infra.sh`, 인프라 준비 확인, Pi·스케줄러 재시작을 차례로 하고 결과를 요청한 채팅으로 보낸다. 준비 확인에 실패하면 기존 Pi를 유지한다. 중복 실행은 막고 결과는 `.s8-runtime/runtime-restarts/<실행ID>/`에 남는다. git pull이나 의존성 설치는 하지 않는다. general 모드는 인프라를 건드리지 않는다. 모델 작업 중에는 먼저 `/abort`한다.
- 오프라인 중 온 메시지는 재연결 시 실행하지 않는다. 다른 장비에서 같은 봇 토큰으로 polling하지 않는다. Telegram 요청 중 확인 대화상자가 열리면 중단을 요청하므로, 추가 확인이 필요한 작업과 민감한 작업은 터미널에서 한다. 정규식 기반 redaction은 완전한 유출 방지책이 아니다.

## 스케줄러

매니저의 `scheduler` 도구가 Projectman 예약을 관리하고 별도 Node 데몬(`s8-main:scheduler`)이 실행한다. 기존 셸 잡의 실행은 유지하지만 매니저가 셸 잡을 만들거나 고치지는 못한다. 매니저 없이 데몬만 쓰려면 `./s8.sh service scheduler`를 실행한다.

- 매일 `HH:mm` 또는 60을 나누는 1~60분 주기를 지원한다. 데몬이 멈춘 동안의 실행은 따라잡지 않는다. 호스트당 하나만 운영한다.
- `kind=projectman`, `projectUid`, `intervalMinutes=5` 잡은 사람이 계획을 확정한 실행 가능 작업을 찾아 알린다. 빈 조회에는 모델·Telegram 호출이 없다. 실행은 상주 워커, `run_worker`, `./s8.sh work`가 한다.
- 모델·프로세스가 끝났다는 이유만으로 완료를 기록하지 않는다. 결과 기록에 실패한 doing 작업은 수동으로 확인한다.
- Telegram `/jobs`, `/jobs pause ID`, `/jobs resume ID`, `/jobs stop ID`로 예약과 현재 배치를 관리한다. 중단은 이미 한 변경을 되돌리지 않는다.
- OS 자동 시작은 별도다. 비정상 종료 후 남은 잠금은 프로세스 종료를 확인한 뒤 정리한다.
- 설정·승인·알림·복구 상세는 [`pi/SCHEDULER.md`](pi/SCHEDULER.md)에 있다.

## 작업요청 등록

원문을 사용자 메시지로 보내거나 Markdown 파일 경로를 지정해 "이 요청문을 Projectman에 등록해줘"라고 요청한다. 매니저의 상세 도구 사용법은 projectman-manager 스킬을 따른다.

- `intake_source`가 실제 사용자 메시지를 원문 그대로 캡처한다. 모델이 다시 쓴 요약은 받지 않는다. `sourceId`로 4,000자 단위로 조회해 분석하고, 여러 메시지는 대화 순서의 JSON으로 보존한다. 승인 전 캡처와 미리보기는 Pi 세션에만 있다.
- `projectman action=intake_preview`는 서버에 쓰지 않는 미리보기다. 원문·생성안·부모 지문을 고정한다. 같은 이름의 기존 항목이 있으면 UID를 골라야 한다.
- `action=intake_register` 또는 `/projectman-register <requestId>`의 대화형 확인을 거친 안만 등록한다. headless 등록·무인 승인은 지원하지 않는다. Telegram에 승인 UI가 전달되지 않으면 웹 터미널이나 TUI에서 승인한다.
- 신규 항목은 `todo`, `autorun=false`, `requiresApproval=true`, `allowedActions=[]`다. 등록은 실행 승인이 아니다.
- 등록은 PH-CMS 단일 트랜잭션이며 실패하면 전체 롤백한다. 같은 요청 ID 재시도는 같은 UID를 돌려주고, 같은 요청 ID로 다른 등록안을 보내면 409다. 응답이 유실되면 새 요청 ID를 만들지 않고 같은 안으로 확인 후 재시도한다. 네트워크 오류에 쓰기 자동 재시도는 없다.
- 원문은 첫 신규 항목의 `intake.manifest`에 한 번 저장한다. `intake_get`은 4,000자 이하 조각으로 조회한다(`offset`, `limit`, `nextOffset`).
- 한도: 원문 64,000자, 부모 포함 100개 항목, 정규화한 요청 200KB. 흔한 인증정보 형태는 거부하지만 DLP가 아니므로 원문에서 비밀정보를 지운다.
- PH-CMS에 `POST /projectman/intakes/preview`, `POST /projectman/intakes`, `GET /projectman/intakes/:requestId`가 있어야 한다. 롤백은 신규 등록을 멈추고 S8 도구를 되돌린 뒤 PH-CMS를 되돌린다. 등록된 콘텐츠는 지우지 않는다.

## Projectman 리소스와 멈춘 실행

- 프로젝트 생성에는 저장소 절대 경로가 필요하다. 위임된 작업의 제목·본문은 직접 수정할 수 없고 매니저와 계획을 고친다.
- 삭제는 확인 버튼으로 하며 하위 자원까지 soft delete한다. 원본·작업 로그·감사는 보존하고 복원 화면은 없다. 하위에 실행 중이거나 종료 미확인 작업이 있거나, 범위 밖 미완료 작업이 선행 항목으로 참조하면 막는다. 5,000개 기록이 넘으면 나눠 지운다. PH-CMS에 `DELETE /projectman/items/:uid/tree`와 `capabilities.cascadeResourceDelete=true`가 필요하다.
- 콘솔 JSON 본문은 384,000바이트, 리소스 본문은 50,000자까지다. 요청 중 401이 나면 조회만 세션 갱신 후 한 번 재시도한다. 쓰기는 자동 재전송하지 않고 `SESSION_RENEWED`를 돌려주며, 화면은 같은 요청 ID로 재시도한다.
- 실행 이벤트는 바이트 커서로 페이지 조회한다(한 페이지 30개·약 1MB, 이벤트 하나 최대 2MB). 알려진 PH-CMS 거부 사유만 고정 안내로 바꾸고 원문 오류는 화면에 보내지 않는다.

멈춘 실행:

- 서버에 doing인데 워커 창이 없어진 실행은 claim한 장비에서 `./s8.sh work <UID>`로 같은 작업 디렉터리에서 이어간다.
- 이어갈 수 없으면 모든 장비에서 워커를 멈춘 뒤(`tmux kill-window -t s8-workers:<UID>`) `./s8.sh finish <UID> --run-id <실행UUID> --confirm-stopped`로 실패 보고를 보내 마무리한다. claim 기록이 없는 장비에서도 되고, 이 장비에 같은 UID 창이 살아 있으면 거부한다. 워커가 보고했지만 전달되지 못했으면 그 보고를 보낸다. 결과는 blocked이며 남은 작업 디렉터리는 직접 확인한다.
- 실패 보고(blocked)된 작업은 콘솔 작업 상세의 `실행 대기로 되돌리기`로 확정한 계획 그대로 다시 실행할 수 있다(PH-CMS `retry`, 사람 세션). 질문이 대기 중이면 쓸 수 없고, 실행 횟수 예산(기본 6회)을 넘으면 PH-CMS가 거부한다. 지난 실행 기록은 남고 같은 작업 디렉터리에서 이어서 실행한다. 계획을 바꿔야 하면 매니저에게 새 작업을 요청한다.
- 콘솔에서도 doing 작업의 실행 기록에서 "모든 장비에서 이 실행이 멈췄음을 확인했습니다."를 체크하고 `실패로 마무리`를 누른다. 권한과 현재 run ID는 사람 세션으로 확인하고 보고는 콘솔 서버의 에이전트 서비스 키로 보낸다.

## PH-CMS 연결

- S8은 비관리자 agent 서비스 키를 `.env`의 `PHCMS_ACCESS_TOKEN`에 둔다. Projectman 도구는 `config.yml`의 `projectman.apiUrl`(HTTPS 또는 루프백 HTTP)을 직접 쓴다. 에이전트는 키 원문이나 환경 파일을 조회하지 않는다.
- 신규 채널은 PH-CMS 루트에서 `pnpm db:setup:projectman <ownerUid> [agentUid]`로 초기화한다.
- PH-CMS는 `127.0.0.1:8000`에서 따로 실행하거나 `projectman.startCommand`로 `s8-infra:phcms` 창에서 실행한다. 라우터의 `/api/v2/`는 원래 URI 그대로 PH-CMS API·관리자 UI로 전달한다.
- 관리자 로그인은 `http://<Tailscale IP>/api/v2/admin/login`이다. 관리자 UI의 API URL은 같은 origin, prefix는 `/api/v2`로 둔다. 원격 장치에서 `localhost:8000`을 쓰지 않는다. 라우터는 별도 인증을 주지 않으며 PH-CMS의 인증·권한 검사를 그대로 쓴다.
- MCP: PH-CMS 루트에서 `pnpm dev -- --server --mcp`로 API와 MCP를 함께 실행한다(호스트 기본값은 현재 Tailscale IPv4). MCP만 실행할 때는 `pnpm --filter @ph-cms/content-mcp dev`(기본 `127.0.0.1`, `PHCMS_MCP_HOST`로 변경). 두 방식을 동시에 쓰지 않는다. MCP는 `PHCMS_BASE_URL`·`PHCMS_API_PREFIX`·`PHCMS_TIMEOUT_MS`만 읽고 S8 `.env`는 읽지 않는다. S8은 서비스 키를 `Authorization: Bearer`로 보내고 MCP가 같은 헤더를 API에 전달한다. 키가 없거나 잘못되면 API 도구만 실패한다.
- 실행 중인 Pi에는 설정·키 변경이 바로 반영되지 않는다. `./s8.sh --continue`나 Telegram `/restart`로 다시 시작한다.

## 상태 점검과 장애 분리

```bash
./start-general-agent.sh --version
tmux has-session -t s8-main && tmux has-session -t s8-infra
curl -fsS http://<bindIp>/health
curl -fsS http://<bindIp>/api/docs/health
curl -fsS http://<bindIp>/api/terminal/health
curl -fsS http://<bindIp>/api/v2/health
curl -fsS http://127.0.0.1:4178/s8/
```

- Pi가 시작되지 않음: Node.js 버전, `npm ci --ignore-scripts --prefix pi`, `pi/node_modules/.bin/pi` 존재를 확인한다. 인증 문제면 Pi에서 `/login`을 다시 한다.
- 라우터 `/health` 실패: `s8-infra:router` 창 출력을 본다. `network.bindIp`가 이 장비에 있는 주소인지, 다른 프로세스가 포트를 쓰는지 확인한다. 권한 오류(EACCES)면 [80번 포트 허용](#80번-포트-허용-리눅스)을 적용한다.
- `/api/docs/` 실패: `s8-infra:kb-browser` 창 출력과 `kbRoot` 경로를 확인하고 `npm test --prefix apps/kb-browser`를 실행한다.
- `/s8/`만 502: `s8-infra:frontend` 창과 `127.0.0.1:4178` 응답을 확인한다.
- `/api/v2/`만 502: PH-CMS가 `127.0.0.1:8000`에서 응답하는지, `s8-infra:phcms` 창 출력(DB 등)을 확인한다.
- 상주 워커가 꺼짐으로 보임: `s8-workers:worker-<id>` 창 출력을 보고 `./s8.sh`로 다시 시작한다.

## 보안과 변경 규칙

- 실제 `.env` 값과 인증정보는 에이전트가 읽거나 기록하지 않는다. 워커는 경로 보호 확장을 로드하지 않고 시스템 프롬프트와 작업 지침에 따라 비밀정보를 보호한다. Bash의 비밀 환경변수 제거는 유지한다. `.pi/`, `.pi-runtime/`, `.s8-runtime/`, `.git/`, 비밀정보 경로를 KB API로 제공하지 않는다. 워커의 파일 접근 범위는 프롬프트로 안내한다.
- 실행 기록은 권한 검사가 있는 콘솔로 조회한다. KB 변경은 `kb` 도구의 정책·버전 확인과 사용자 확인을 거친다.
- 사용자 승인 없이 외부 전송, 배포, 삭제, 중요한 방향 확정을 하지 않는다. 공개 바인딩, 포트, 인증 정책 변경도 승인을 받는다.
- `s8-infra` 세션 종료와 `start-infra.sh` 재실행은 서비스를 멈추므로 명시적 요청이나 승인 후에 한다.
- Pi extension은 전체 시스템 권한으로 실행되므로 검토한 코드만 쓴다. 외부 package와 extension은 실행 전 소스와 권한을 검토한다.
- 패키지 버전은 정확히 고정하고 잠금 파일을 커밋한다. Git에는 Pi 버전, 잠금 파일, `pi/`의 설정·extension·skill을 넣고 `.pi-runtime/`, `.s8-runtime/`, `.env`, `config.yml`, 로그, 업로드는 넣지 않는다.
- 작업 메모 폴더와 진행 이력 Markdown은 만들지 않는다. 작업 맥락은 Pi 세션에 두고, Projectman 상태와 작업 로그는 PH-CMS가 관리한다.
- 환경변수를 바꾸면 같은 작업에서 `.env.example`도 갱신한다. 인프라를 바꾸면 셸 문법과 관련 테스트를 검증한다.

## 코드 위치

```text
s8-agent/
├── agents/{general,manager,worker}/  # 모드별 profile.json·SYSTEM.md
├── apps/
│   ├── kb-browser/          # 지식베이스·업로드 API
│   ├── terminal-gateway/    # 호스트 PTY·tmux 웹 터미널
│   ├── telegram-gateway/    # Telegram 명령·알림
│   ├── comm-center/         # 에이전트 통신 중계
│   └── mcp-hub/             # MCP 허브
├── frontend/                # 웹 콘솔(Projectman, 지식베이스, 업로드, 터미널)
├── infra/router/            # 경로별 proxy(Node)
├── pi/
│   ├── bin/                 # CLI 진입점
│   ├── extensions/          # Pi 도구·이벤트 연결
│   ├── skills/              # S8 스킬과 vendor 스킬
│   ├── lib/
│   │   ├── config/          # config.yml 읽기·검증
│   │   ├── agent/           # 모드 프로필·실행기, 워커 claim·보고, 작업 실행, 상주 워커
│   │   ├── development/     # worktree·패치, 보고 outbox
│   │   ├── manager/         # KB 접근, 보고 수신함
│   │   ├── projectman/      # PH-CMS API, 사전 검토, 웹 콘솔·인증·이력
│   │   ├── runtime/         # tmux 세션, 서비스·상주 워커 기동, 재시작
│   │   ├── scheduler/       # 예약 저장·제어·실행
│   │   ├── telegram/        # 알림 전송과 연결 상태
│   │   └── storage/         # 민감 값 필터링·원자적 JSON 기록
│   └── test/                # 회귀 테스트, helpers/, manual/(실제 모델 평가)
├── start-*-agent.sh, s8.sh, start-infra.sh
├── .pi-runtime/             # 장비별 Pi 인증·세션(Git 제외)
└── .s8-runtime/             # 실행 기록·worktree·업로드·워커 상태(Git 제외)
```

| 찾으려는 기능 | 구현 위치 | 진입점 |
| --- | --- | --- |
| 모드·실행 인자·재시작 | [agent/launch.mjs](pi/lib/agent/launch.mjs), [agent/profile.mjs](pi/lib/agent/profile.mjs) | `start-*-agent.sh` → `pi/bin/agent.mjs` |
| 워커 claim·보고 | [agent/worker-run.mjs](pi/lib/agent/worker-run.mjs), [extensions/worker.ts](pi/extensions/worker.ts) | `start-worker-agent.sh` |
| 작업 실행(디렉터리·창) | [agent/work.mjs](pi/lib/agent/work.mjs) | `s8.sh work`, `run_worker` |
| 상주 워커 | [agent/resident.mjs](pi/lib/agent/resident.mjs), [runtime/services.mjs](pi/lib/runtime/services.mjs) | `s8.sh service worker`, 콘솔, `set_worker_mode` |
| 보고 전달 | [development/outbox.mjs](pi/lib/development/outbox.mjs), [manager/run-results.mjs](pi/lib/manager/run-results.mjs) | 워커 보고, 매니저 polling |
| 완료·검토의견 수신 | [manager/inbox.mjs](pi/lib/manager/inbox.mjs), [extensions/manager.ts](pi/extensions/manager.ts) | 매니저 polling |
| Projectman API·콘솔 | [projectman/client.ts](pi/lib/projectman/client.ts), [projectman/console.mjs](pi/lib/projectman/console.mjs) | `pi/extensions/projectman.ts`, `pi/bin/projectman-console.mjs` |
| tmux 런타임 | [runtime/](pi/lib/runtime/) | `s8.sh` → `pi/bin/s8.mjs` |
| 설정·알림 | [config/s8-config.mjs](pi/lib/config/s8-config.mjs), [telegram/notify.mjs](pi/lib/telegram/notify.mjs) | `pi/bin/s8-config.mjs` |
| 예약 | [scheduler/](pi/lib/scheduler/) | `s8.sh service scheduler`, `pi/extensions/scheduler.ts` |
| 라우터 | [infra/router/router.mjs](infra/router/router.mjs) | `start-infra.sh` |

개발 흐름은 `agent/work → extensions/worker → agent/worker-run → development/outbox` 순서로 읽는다.

## 에이전트 메시지 통신

실행 중인 매니저·워커 Pi 세션이 `apps/comm-center`를 거쳐 텍스트를 주고받는다. 매니저와 워커는 같은 클라이언트이고, 정체성과 역할은 comm-center 등록부가 토큰으로 정한다. 워커 간 대화는 매니저가 중개한다. 원격 작업 실행·워커 모드 변경·파일 전송·에이전트 자동 생성은 지원하지 않는다. 로컬 Projectman 작업과 상주 워커 관리는 기존 실행기로 처리한다.

```text
매니저 Pi ─┐
워커 Pi  ──┼─ WebSocket ─ apps/comm-center
워커 Pi  ──┘
```

### comm-center 준비

comm-center는 한 장비에서만 실행한다. 설치·등록·보안은 [apps/comm-center/README.md](apps/comm-center/README.md)에 있다.

```bash
npm ci --prefix apps/comm-center
cp apps/comm-center/.env.example apps/comm-center/.env   # 등록부 경로·바인딩 IP·포트
npm run issue --prefix apps/comm-center -- ~/.config/s8/comm-center-agents.json manager manager ~/.config/s8/comm-manager.json
npm run issue --prefix apps/comm-center -- ~/.config/s8/comm-center-agents.json a worker ~/.config/s8/comm-a.json
npm start --prefix apps/comm-center   # start-infra.sh는 .env가 있으면 comm-center 창에서 실행한다
```

등록부에는 토큰 해시만 저장한다. 토큰 파일(권한 600)을 해당 에이전트의 장비로 옮기고, 등록부를 바꾼 뒤에는 comm-center를 재시작한다. 실제 토큰 파일은 Git에 넣거나 에이전트에게 조회시키지 않는다.

### 에이전트 장비 설정

각 장비의 `config.yml`에는 주소와 토큰 파일만 둔다. 매니저와 워커가 같은 형식이다.

```yaml
communication:
  enabled: true
  url: ws://10.0.0.10:8090
  tokenFile: ~/.config/s8/comm-a.json
```

Pi는 `apps/comm-center/client.mjs`를 경로로 불러오며 Node 내장 WebSocket만 쓰므로, 에이전트 장비에서는 comm-center 의존성을 설치하지 않아도 된다. comm-center는 WS만 제공한다. 장비 사이에는 암호화된 사설망이나 TLS 프록시의 WSS를 사용한다. 에이전트 장비에는 수신 포트가 필요 없다.

### 실행과 대화

설정이 있으면 매니저·워커 에이전트가 시작할 때 연결한다.

```bash
./start-manager-agent.sh
./start-worker-agent.sh --cwd /srv/projects/app
```

UID 없이도 메시지를 받는다. 한 토큰에는 한 번에 한 세션만 연결할 수 있으며, 같은 토큰의 두 번째 세션은 연결이 거부되고 경고를 표시한다. 한 체크아웃에서 여러 세션을 동시에 쓰려면 세션마다 토큰을 따로 발급하고 실행 명령 앞에 `S8_COMM_TOKEN_FILE=경로`를 지정한다. `workers` 목록과 `./s8.sh workers`는 로컬 Projectman 작업 루프 전용이며 통신 정체성과 별개다.

매니저는 `agent_message {action: "list"}`로 등록된 에이전트와 연결 상태를 확인한다. `request`·`reply`·`notice`·`proposal`·`result`는 텍스트를 전달하고, `status {messageId}`는 전달 상태를 조회한다. 매니저는 `to`로 대상을 고르고, 여러 대상에는 대상마다 메시지 ID와 공통 `groupId`가 붙는다. 워커는 `to`를 생략하면 매니저에게 보낸다. 워커끼리는 보낼 수 없다. 답변에는 받은 메시지 ID를 `replyTo`로 넣는다.

수신 메시지는 현재 모델·도구 실행이 끝난 뒤 세션에 추가되어 후속 응답을 시작한다. 워커는 매니저의 지시를 기존 도구와 승인 범위 안에서 판단해 수행할 수 있으며, 메시지가 새 권한을 주지는 않는다. `pending`은 수신 세션 대기, `injected`는 세션 기록에 추가됨을 뜻하며 답변·작업 완료를 보장하지 않는다. 연결되지 않은 대상에는 `unavailable`, 전달 여부를 확인하지 못한 경우에는 `unknown`을 반환한다. 오프라인 보관과 자동 재전송은 없다.

comm-center 프로토콜은 v1이며 comm-center와 에이전트 체크아웃을 같은 버전으로 업데이트한다. 연결은 자동 재시도하며 heartbeat·크기 제한·중복 방지·전달 확인을 유지한다. 로그는 연결·메시지 ID·전달 상태·지연만 기록하며 대화와 토큰은 기록하지 않는다. 상세 구조는 [메시지 통신 구조](docs/distributed-multi-agent-plan.md)를 참고한다.

## 다른 장비에서 재현

```bash
git clone <knowledge-base-url> 854_md
git clone <s8-agent-url> s8-agent
cd s8-agent
npm ci --ignore-scripts --prefix pi
```

이후는 [빠른 시작](#빠른-시작)과 같다.

- Pi `1.3.0`을 쓰며 `pi/package-lock.json`으로 같은 버전을 설치한다. `pi/`의 설정, extension, skill, 시스템 지침은 모든 장비가 공유한다.
- `.pi-runtime/`(인증, 세션, 캐시, 설치 패키지), `.env`, `config.yml`, 로그, 업로드는 장비마다 따로 둔다.

[pi-clinepass-provider](https://github.com/jellydn/pi-clinepass-provider) `1.6.0`은 `pi/package-lock.json`에 고정된 공통 의존성이며 `npm ci --ignore-scripts --prefix pi`로 함께 설치된다. 실행기는 자동 발견을 꺼도 이 provider를 명시적으로 로드하므로 범용·매니저·워커와 tmux의 관리 세션에서 모두 사용할 수 있다.

발급받은 ClinePass API 키는 이 장비의 루트 `.env`에 `CLINE_API_KEY`로 직접 설정한다([예시](.env.example)). 실행 중인 에이전트를 다시 시작한 뒤 `/model`에서 `clinepass` 모델을 선택하거나 실행할 때 지정한다. 기존 기본 provider·model은 유지된다.

```bash
./start-general-agent.sh --provider clinepass --model cline-pass/glm-5.3 --thinking high
./start-manager-agent.sh --provider clinepass --model cline-pass/glm-5.3 --thinking high
./start-worker-agent.sh --provider clinepass --model cline-pass/deepseek-v4.1-flash --thinking high
```

키는 모델 통신에 사용되며 에이전트의 bash 도구 환경에서는 제거된다. 다른 장비에서는 각 장비에 키를 따로 설정한다.

선택 Pi 패키지는 아래처럼 설치한다. 자동 발견을 끄므로 설치해도 도구가 자동으로 늘지 않는다. MCP를 쓰려면 구현 하나를 골라 프로필의 확장과 도구 목록을 함께 고친다.

```bash
./start-general-agent.sh install npm:@calesennett/pi-codex-usage@0.1.14   # Codex 사용량 footer
./start-general-agent.sh install npm:pi-web-access@0.33.0                 # 웹 검색·fetch·PDF 분석
./start-general-agent.sh install npm:pi-mcp-extension@1.5.0               # MCP 클라이언트
```

## 검증

저장소 루트에서 실행한다.

```bash
node --test pi/test/*.test.mjs apps/telegram-gateway/gateway.test.mjs
npm test --prefix apps/comm-center
npm test --prefix apps/terminal-gateway
npm test --prefix apps/kb-browser
npm run test:run --prefix frontend
npm run lint --prefix frontend
npm run build --prefix frontend
bash -n start-general-agent.sh start-manager-agent.sh start-worker-agent.sh s8.sh start-infra.sh
git diff --check
```

- `pi/test/pi-sdk.test.mjs`는 로컬 모의 API와 설치된 Pi SDK로 매니저의 Bash 실행과 파일 쓰기를 검증한다. 외부 모델 API는 쓰지 않는다.
- `pi/test/projectman-http.test.mjs`는 형제 `ph-cms/packages/server`의 Fastify로 실제 HTTP를 검증한다. 의존성이 없으면 건너뛰므로 완전 검증으로 보지 않는다. PH-CMS의 intake 테스트는 비어 있는 일회용 DB에서만 실행하고 운영 DB에는 fixture·reset을 실행하지 않는다.
- 실제 모델을 쓰는 역할 평가는 `node pi/test/manual/evaluate-roles.mjs`로 따로 실행한다. 모델 인증과 사용량이 든다.

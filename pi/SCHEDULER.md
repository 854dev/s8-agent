# S8 스케줄러

S8 관리 대화의 `scheduler` 도구로 Projectman 예약을 관리하고, 별도 Node 프로세스가 예약 시각에 실행한다. 기존 셸 예약 실행은 유지하지만 관리 역할에서 셸 예약 생성·변경·삭제는 차단한다. Projectman 잡은 5분마다 조회하되 실행 가능한 워크·서브워크가 없으면 모델을 호출하거나 Telegram에 알리지 않는다. 운영체제별 cron 문법이나 패키지 없이 같은 스케줄러 코드를 사용한다.

## 실행

```bash
./start-pi.sh                    # 매니저 + 스케줄러 + 개발 슈퍼바이저
./start-pi.sh --no-scheduler     # 스케줄러 자동 시작 제외
./start-pi.sh --service scheduler            # 예약 데몬만 전경에서 실행
```

통합 실행은 기본 `s8-main` tmux 세션의 `scheduler` 창을 만들고, 재실행 시 정상 종료한 뒤 같은 창에서 프로세스를 교체한다. `--session 이름`을 지정하면 해당 런타임 세션에 같은 서비스 창을 연결한다. 매니저가 끝나도 예약 데몬은 유지된다. 제외 옵션은 이미 실행 중인 데몬을 종료하지 않는다.

`start-pi.sh --service scheduler` 단독 실행은 포그라운드 서비스다. 예약 실행을 유지하려면 macOS `launchd`, Linux `systemd --user`, Windows 작업 스케줄러 등 해당 OS의 서비스 관리자에 시작 명령을 등록한다. 여러 인스턴스가 동시에 시작되면 하나만 소유권을 얻고 나머지는 종료한다. tmux 세션의 정상 종료 신호(`SIGINT`, `SIGTERM`, `SIGHUP`)에는 실행 중 작업을 정리한 뒤 소유 잠금을 제거한다. 전원 종료나 강제 종료 등 신호를 처리하지 못한 비정상 종료 후 `.s8-runtime/scheduler/owner.lock`이 남으면 스케줄러가 실행 중이지 않은 것을 확인한 뒤 해당 잠금 파일만 제거한다.

Pi CLI와 인증정보는 `start-pi.sh`와 같은 `.pi-runtime`을 사용한다. `.env`는 시작 시 읽되 출력하거나 기록하지 않는다.

## 예약 CRUD

S8 대화에서 자연어로 `scheduler` 도구를 호출해 관리한다.

- `list`: 예약과 최근 결과 확인
- `create`: `id`와 잡 종류별 설정 필수. `kind=shell`(기존 기본값)은 `script`와 `time`(24시간 `HH:mm`) 또는 `intervalMinutes` 중 하나를 지정한다. 주기는 60을 나누어 떨어뜨리는 1~60분이며 `30`은 매시 :00·:30에 실행한다.
- `kind=projectman`: `projectUid` 필수, 주기는 `intervalMinutes=5`로 고정하고 `script`는 지정하지 않는다. 잡마다 지정 프로젝트만 조회한다.
- `timezone`은 IANA 시간대이며 기본값은 장비의 시간대
- `expiresAt`: 선택적 종료 시각. 명시적 시간대가 포함된 ISO 시각으로 지정하며 종료 시각부터 새 배치를 시작하지 않고 실행 중 배치에도 남은 시간을 한도로 적용한다. `null`로 제한을 해제할 수 있다. 기존 종료 시각 없는 예약의 동작은 유지된다.
- `update`: 종류, 프로젝트, 시각, 시간대, 활성화 여부, 종료 시각, 스크립트 변경
- `delete`: 예약과 스크립트 삭제

생성·수정·삭제에는 대화형 확인이 필요하다. 실행 상태와 예약은 `.s8-runtime/scheduler/`에 저장하고 Git에는 포함하지 않는다. 동시 수정용 `jobs.json.lock`이 비정상 종료로 남으면 Pi 작업이 끝난 것을 확인한 뒤 잠금 파일을 제거한다.

## Telegram 예약·배치 관리

메뉴의 `배치` 버튼 또는 `/jobs`로 목록과 마지막 실행 상태를 확인한다. 모델을 호출하지 않고 직접 처리하므로 Pi 응답 중에도 사용할 수 있다.

- `/jobs pause <id>`: 앞으로의 예약 실행 정지. 현재 배치는 계속 실행
- `/jobs resume <id>`: 예약 재개
- `/jobs stop <id>`: 현재 실행 중인 배치와 자식 프로세스 중단 요청. 앞으로의 예약은 유지

배치 중단은 이미 수행한 파일·DB 변경을 롤백하지 않는다. 종료된 데몬의 마지막 `running` 기록은 실제 프로세스 생존을 보장하지 않는다. 실행 취소 요청은 실행별 ID로 구분해 다음 배치에 적용되지 않도록 한다. Telegram에서 임의 스크립트 생성·삭제는 제공하지 않으며 기존 대화형 승인 정책을 유지한다.

## Projectman 지시 잡

- 예약 틱은 지정 프로젝트의 승인된 ready 작업을 조회한다. 실제 UID 배정은 공유 supervisor가 담당하며 스케줄러가 별도 개발 프로세스를 실행하지 않는다.
- 현재 계획에 대한 사용자 승인, 예정 시각과 의존성 검증은 유지한다. 병렬도는 s8-config.yml의 worker-entries 중 연결된 유휴 워커 수다.
- 워커는 작업별 worktree에서 구현·검증하고 결과·패치를 보존한다. 성공 보고는 review로 저장하고 매니저 전달과 Telegram 개발 완료 알림을 독립적으로 수행한다. 매니저 review_result와 사람의 최종 complete 후 done이 된다.
- s8의 work당 실행 예산과 자동 retry는 없다. 최종 완료 확인은 기존 서버 계약을 따른다. 수정은 새 work로 등록한다.
- 예약 틱의 종료·중지는 이미 배정된 work를 중단하지 않는다. 실제 work 취소는 Projectman에서 수행한다. 기존 shell 잡의 배치 중지는 별도 동작이다.
- 예약 조회에서는 완료 알림을 중복 전송하지 않는다. 실행별 보고 outbox가 완료 알림과 재시도를 담당한다.

## 스크립트와 Pi CLI

스크립트는 최대 8 KB이며 `<s8-agent>/.s8-runtime/scheduler/scripts/<id>.sh`로 저장한다. 각 스크립트는 현재 OS 사용자 권한으로 실행되므로, 예약을 만들기 전에 내용을 확인한다. S8이 생성한 스크립트는 사용자의 승인 후 예약 시각에 자동 실행된다.

예시 스크립트 내용:

```bash
#!/usr/bin/env bash
set -euo pipefail
"$S8_PI_BINARY" --print --no-session \
  --extension "$S8_PI_CONFIG_ROOT/extensions/projectman.ts" \
  --append-system-prompt "$S8_PI_CONFIG_ROOT/APPEND_SYSTEM.md" \
  'ph-projectman을 읽고 오늘 할 일을 우선순위와 함께 한국어로 요약해줘. 상태는 변경하지 마.'
```

스크립트 stdout/stderr 결과는 Telegram 대상이 설정되어 있으면 알림으로 전송한다. 봇 토큰은 환경변수 `TELEGRAM_BOT_TOKEN`에 유지하고, 저장소 루트 `s8-config.yml`의 `telegram.allowedUserIds`·`allowedGroupIds`·`scheduleChatId`로 허용 목록과 알림 대상을 지정한다. 대상 chat ID는 허용 목록 중 하나와 일치해야 한다. 파일이 없을 때만 기존 ID 환경변수를 사용하며, 파일이 있으면 누락된 값도 환경변수로 보충하지 않는다. 잘못된 파일은 시작 오류로 처리한다. 알림 대상을 지정하지 않으면 일반 예약 결과는 stdout에만 출력되며 부재중 운영 명령은 시작을 거부한다.

- 일시적 연결 오류·HTTP 429·5xx는 메시지 조각당 최대 3회 시도한다. 영구 오류는 재시도하지 않는다. 응답 유실 시 같은 알림이 중복 도착할 수 있다.
- 실행 결과와 알림 전송 상태는 별개다. `/jobs`는 `실행 success/failed`와 `알림 pending/sent/failed/not_configured`를 구분한다. 기존 기록은 `알림 미기록`으로 표시한다.
- `sent`는 Telegram API 접수 성공이며 실제 기기의 수신·읽음 확인은 아니다. 실패 원인은 HTTP 상태나 일반화한 연결 오류만 저장하고 알림 본문·인증정보는 상태 파일에 저장하지 않는다.
- 이 스크립트 결과 전송은 기존 쉘 잡의 호환 동작이다. Projectman 지시 잡에는 적용하지 않는다. 지시 잡의 빈 조회·승인 대기는 반복 알리지 않는다.

## 제약

- 매일 `HH:mm` 또는 분 주기를 지원한다. 예약 시각에 스케줄러가 실행 중이 아니면 해당 실행은 건너뛰고 나중에 따라잡지 않는다.
- `.sh` 실행에는 Bash가 필요하다. Windows에서는 Git Bash 등 Bash를 PATH에 설치한다.
- 각 호스트에서 스케줄러 인스턴스 하나만 실행한다. 상태는 호스트별 로컬 런타임에 저장되며 다른 장치와 자동 동기화하지 않는다.
- 스크립트 출력은 Telegram으로 전송될 수 있으므로 비밀정보를 출력하지 않는다. 기본 redaction은 완전한 유출 방지책이 아니다.

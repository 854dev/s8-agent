# S8 스케줄러

S8 Pi 대화에서 `scheduler` 도구로 매일 실행할 쉘 작업을 CRUD하고, 별도 Node 프로세스가 예약 시각에 실행한다. 운영체제별 cron 문법이나 패키지 없이 같은 스케줄러 코드를 사용한다.

## 실행

```bash
./start-scheduler.sh
```

이 명령은 포그라운드 서비스다. 예약 실행을 유지하려면 macOS `launchd`, Linux `systemd --user`, Windows 작업 스케줄러 등 해당 OS의 서비스 관리자에 시작 명령을 등록한다. 여러 인스턴스가 동시에 시작되면 하나만 소유권을 얻고 나머지는 종료한다. 비정상 종료 후 `.s8-runtime/scheduler/owner.lock`이 남으면 다른 인스턴스가 시작되지 않는다. 스케줄러가 실행 중이지 않은 것을 확인한 뒤 해당 잠금 파일만 제거한다.

Pi CLI와 인증정보는 `start-pi.sh`와 같은 `.pi-runtime`을 사용한다. `.env`는 시작 시 읽되 출력하거나 기록하지 않는다.

## 예약 CRUD

S8 대화에서 자연어로 `scheduler` 도구를 호출해 관리한다.

- `list`: 예약과 최근 결과 확인
- `create`: `id`, `script`와 `time`(24시간 `HH:mm`) 또는 `intervalMinutes` 중 하나 필수. 주기는 60을 나누어 떨어뜨리는 1~60분이며 `30`은 매시 :00·:30에 실행. `timezone`은 IANA 시간대이며 기본값은 장비의 시간대
- `update`: 시각, 시간대, 활성화 여부, 스크립트 변경
- `delete`: 예약과 스크립트 삭제

생성·수정·삭제에는 대화형 확인이 필요하다. 실행 상태와 예약은 `.s8-runtime/scheduler/`에 저장하고 Git에는 포함하지 않는다. 동시 수정용 `jobs.json.lock`이 비정상 종료로 남으면 Pi 작업이 끝난 것을 확인한 뒤 잠금 파일을 제거한다.

## Telegram 예약·배치 관리

메뉴의 `배치` 버튼 또는 `/jobs`로 목록과 마지막 실행 상태를 확인한다. 모델을 호출하지 않고 직접 처리하므로 Pi 응답 중에도 사용할 수 있다.

- `/jobs pause <id>`: 앞으로의 예약 실행 정지. 현재 배치는 계속 실행
- `/jobs resume <id>`: 예약 재개
- `/jobs stop <id>`: 현재 실행 중인 배치와 자식 프로세스 중단 요청. 앞으로의 예약은 유지

배치 중단은 이미 수행한 파일·DB 변경을 롤백하지 않는다. 종료된 데몬의 마지막 `running` 기록은 실제 프로세스 생존을 보장하지 않는다. 실행 취소 요청은 실행별 ID로 구분해 다음 배치에 적용되지 않도록 한다. Telegram에서 임의 스크립트 생성·삭제는 제공하지 않으며 기존 대화형 승인 정책을 유지한다.

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

스크립트 stdout/stderr 결과는 Telegram 대상이 설정되어 있으면 알림으로 전송한다. `.env`에 `TELEGRAM_BOT_TOKEN`, 허용된 사용자/그룹 ID와 `S8_SCHEDULE_TELEGRAM_CHAT_ID`를 설정한다. 대상 chat ID는 허용 목록 중 하나와 일치해야 한다. 설정하지 않으면 결과는 스케줄러 실행 로그(stdout)에만 출력된다.

## Projectman 카운트 테스트

`pi/bin/count-test.mjs`는 지정 프로젝트의 차감 테스트만 수행한다. 일반 작업의 자연어 지시를 자동 실행하지 않는다.

```bash
node --env-file=.env pi/bin/count-test.mjs setup
node --env-file=.env pi/bin/count-test.mjs schedule <task-uid> '2026-10-14T09:00:00+09:00'
```

- `setup`: `854-workspace` → `100에서 출발해서 카운트하기` → 1·2·3 차감 작업을 생성하고 `projectman-count` 30분 예약을 등록한다. 반복 실행 시 기존 콘텐츠를 재사용한다.
- 작업의 `attributes.scheduledAt`은 처음에는 `null`이다. 위 `schedule` 명령으로 예정 시각을 지정하거나, S8의 Projectman `schedule` 도구로 변경할 수 있다. 작업을 시작한 뒤에는 시각 수정이 차단된다.
- 순서대로 하나씩 처리하며 첫 미완료 작업의 예정 시각이 도래하지 않으면 다음 작업도 기다린다. 09:10 예약은 스케줄러가 정상 실행 중일 때 09:30 검사에서 수행한다.
- `~/projectman-result.txt` 첫 줄은 `100`, 이후 줄은 `값<TAB>작업 UID<TAB>차감량<TAB>실행 시각`이다. UID가 이미 기록되면 차감하지 않고 Projectman 완료 처리만 복구한다.
- S8의 `PHCMS_ACCESS_TOKEN`에 설정한 서비스 키를 MCP 요청 헤더로 전달한다. MCP 서버에는 키를 저장하지 않는다. 수동 CLI는 위 명령처럼 S8 환경을 로드하고, 예약 실행은 스케줄러가 시작 시 로드한 환경을 사용한다. 쓰기 가능한 MCP 인증이 필요하다. 현재 테스트 CLI는 이 장비의 `http://100.120.50.80:3001/mcp`를 사용한다. 다른 장비에서는 이 주소를 바꾼다.
- 데몬과 테스트 실행기는 한 호스트에서만 운영한다. 다른 호스트의 별도 결과 파일과 실행을 조정하지 않는다. 비정상 종료 시 `projectman-result.txt.lock`이 남으면 실행기가 완전히 종료된 것을 확인하고 잠금 파일만 제거한다.

## 제약

- 매일 `HH:mm` 또는 분 주기를 지원한다. 예약 시각에 스케줄러가 실행 중이 아니면 해당 실행은 건너뛰고 나중에 따라잡지 않는다.
- `.sh` 실행에는 Bash가 필요하다. Windows에서는 Git Bash 등 Bash를 PATH에 설치한다.
- 각 호스트에서 스케줄러 인스턴스 하나만 실행한다. 상태는 호스트별 로컬 런타임에 저장되며 다른 장치와 자동 동기화하지 않는다.
- 스크립트 출력은 Telegram으로 전송될 수 있으므로 비밀정보를 출력하지 않는다. 기본 redaction은 완전한 유출 방지책이 아니다.

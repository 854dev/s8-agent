# 개발 워커 풀 개편 계획

## 확정 범위

PH-CMS를 수정하지 않고 s8만 기존 Projectman v2 계약에 맞춘다. 사용자 화면 승인을 실행 대기열로 삼고, worker-entries에 등록한 에이전트가 UID 단위로 작업한다. 로컬 Pi 워커는 전용 tmux 세션에서 유지하며, 등록하지 않은 워커를 기본 생성하지 않는다.

```text
사용자 계획 승인 → ready → supervisor 원자적 claim → doing
  → 워커 projectman get → 격리 worktree 구현·검증 → report
  → review 저장 → 매니저 inbox + Telegram 개발 완료 링크
  → 워커 턴 종료 확인 → idle → 다음 독립 UID

review → 매니저 review_result → 사용자가 화면에서 complete → done
```

개발 완료 통지는 사람의 응답을 기다리지 않는다. 최종 완료는 기존 서버가 요구하는 매니저 검토·사람 확인을 유지한다. 선행 작업·하위 작업에 의존하는 후속 작업은 done 이후에 실행된다. 수정은 새 work로 생성하고 승인하며 별도 재작업 로직을 구현하지 않는다.

## Ponytail 검토 반영

[ponytail 지침](https://github.com/dietrichgebert/ponytail/blob/main/skills/ponytail/SKILL.md)에 따라 기존 실행·저장 경로를 재사용하고 기능에 필요한 변경만 한다.

| 검토 대상 | 결정 |
| --- | --- |
| PH-CMS 스키마·상태·MCP 변경 | 생략. 기존 v2 claim/report/review_result/complete 사용 |
| 별도 UID 실행 대기열 | 생략. 승인된 ready 작업을 기존 API로 조회 |
| 서버 이벤트 브로커와 outbox | 생략. 기존 s8 실행별 보고 outbox 재사용 |
| 매니저 수신 서버·추가 타이머 | 생략. 기존 manager polling에 inbox 처리와 review 누락 확인 통합 |
| Telegram 별도 서비스 | 생략. 기존 수신 설정과 공통 전송 함수 사용 |
| 재작업·retry·질문 기반 자동 재개 | s8 실행 경로에서 제거. 수정은 새 work |
| 제한 필드 서버 마이그레이션 | 생략. 서버 필드는 유지하고 s8 실행 제한은 제거 |
| 별도 작업별 Pi 프로세스 | 지속 워커와 작업마다 새 SDK 대화로 대체 |

## 구현 작업

1. **기동·워커 수명 관리**: start-pi가 YAML의 worker-entries를 읽고 로컬 관리 Pi 항목마다 설정된 ID의 창을 만든다. 재시작·중복 기동·실행 중 항목 변경을 처리한다. 워커별 Unix 소켓으로 UID/runId를 전달하고 중복 배정을 막는다. 원격 워커 통신·기동은 [공통 워커 구현 계획](remote-worker-implementation-plan.md)에서 다룬다.
2. **기존 배정기 통합**: supervisor가 승인·예정 시각·담당자·의존성을 확인하고 원자적 claim을 사용한다. 기존 run이 있는 work는 재실행하지 않는다. 예약 조회도 같은 배정기를 사용한다.
3. **실행과 보존**: 워커가 projectman으로 UID를 먼저 조회하고 승인된 계획을 수행한다. 작업별 worktree와 새 대화를 사용하며 결과·검증·판단·오류·패치를 보존한다. 토큰·작업 시간·명령 수로 중단하지 않는다. 사용자 취소·인프라 실패는 보존한다.
4. **보고와 알림**: 기존 outbox가 같은 requestId로 서버 report를 재전송하고 결과를 저장한다. 매니저 inbox와 Telegram 전달 상태를 별도로 보존한다. 성공 문구는 ‘개발 완료 · 최종 확인 대기’이며 work/run 링크를 포함한다. 설정 누락은 미전송으로 남긴다.
5. **검토와 화면**: 매니저는 보고 또는 기존 polling으로 review를 발견하고 workflow_get 검토 후 review_result를 기록한다. 화면은 매니저 검토 후 최종 완료 버튼을 제공한다. 사람의 완료가 다음 독립 작업 배정을 막지는 않는다.
6. **문서와 테스트**: 역할 지침·예약 문서·도움말·평가를 같은 계약으로 맞춘다. PH-CMS를 변경하지 않는 전체 연동 테스트는 s8에 둔다.

## 검증 기준

- 명시한 두 개 또는 임의 개수의 worker ID, 중복 시작·UID 전달·소켓 복구 검증.
- 서로 격리된 작업 실행, 빈 워커 재사용, 다른 워커 실행 중 다음 독립 UID 배정.
- 기존 승인 버전·원자적 claim·멱등 report·취소·실패 보존.
- 성공 보고 후 review 저장, 사용자 미응답 상태에서도 개발 완료 알림과 워커 반환.
- Telegram 실패 후 재시도, 매니저 미접속 후 inbox 수신, 알림 링크 로그인 후 task/run 유지.
- 매니저 검토 전 최종 완료 불가, 검토 후 화면에서 done 처리. 의존 작업은 done까지 대기.
- Node 회귀, 프런트엔드 테스트·빌드, 기존 PH-CMS PostgreSQL 회귀, 임시 DB에서 실제 SDK·브라우저 전체 연동.

[상세 연동 계약과 테스트 실행법](projectman-worker-pool-contract.md)을 따른다. 운영 배포·커밋·실제 Telegram 전송은 검증 범위에 포함하지 않는다.

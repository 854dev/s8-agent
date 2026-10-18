# PH-CMS 수정 없는 워커 연동 계약

PH-CMS dev의 기존 Projectman v2 API를 그대로 사용한다. 서버 코드·스키마·MCP·운영 DB 변경은 없다. 이번 작업에서 적용했던 PH-CMS 변경은 되돌렸다.

## 상태와 책임

| 단계 | 처리 주체 | 기존 API / 상태 |
| --- | --- | --- |
| 계획·사전 검토 | 매니저 | delegate, preflight_review → todo |
| 화면에서 최종 계획 승인 | 사용자 | authorize → ready |
| 실행할 UID 배정 | s8 supervisor | 원자적 claim → doing |
| UID 조회·구현·검증·보고 | 워커 | projectman get/report, 성공 시 review |
| 개발 완료 통지 | s8 outbox | 매니저 inbox와 Telegram에 결과 요약·work/run 링크 |
| 결과와 검증 근거 검토 | 매니저 | workflow_get → review_result |
| 화면에서 검토의견과 완료 제출 | 사용자 | 의견을 complete.message에 기록 → done, 매니저 inbox 전달 |

워커는 보고의 서버 저장과 실제 턴 종료를 확인하면 idle로 돌아간다. 사람의 최종 확인과 관계없이 다음 독립 작업을 받을 수 있다. 선행 작업이나 하위 작업을 기다리는 작업은 기존 서버 계약대로 done 이후에 실행된다.

서버 capability는 `workflowVersion: 2`, `atomicClaims: true`, `idempotentReports: true`를 확인한다. 별도 workerPool capability나 서버 이벤트 브로커를 추가하지 않는다. 기존 requestId/runId/revision과 report 트랜잭션·불변 work_log를 재사용한다.

## 유지되는 제약

- 성공 report는 done이 아니라 review다. 기존 서버의 매니저 검토와 사람의 최종 완료 조건을 우회하지 않는다.
- 서버의 timeBudgetMinutes/maxRuns 필드·기본값은 남는다. s8는 이 필드를 생성·설정하거나 시간·토큰 중단 기준으로 사용하지 않는다. 기존 서버의 claim 검증은 유지된다.
- s8는 실행 이력이 있는 동일 work를 다시 배정하지 않는다. 실패·수정 요청은 원본 링크와 수정 내용을 담은 새 work로 등록하고 승인한다. 서버에 남아 있는 retry API를 s8에서 사용하지 않는다.
- 사용자 취소·담당자·예정 시각·승인 버전·의존성·상하위 실행 조정 검증을 유지한다.
- Telegram 오류나 매니저 미접속은 다음 독립 작업 배정을 막지 않는다. outbox가 전달 상태를 각각 보존한다. 전송 응답 유실 때 알림은 중복될 수 있다.
- 공개 `publicUrl`과 명시적 `telegram.scheduleChatId`가 없으면 Telegram은 미전송 상태로 남는다. 실제 수신 설정이 필요하다.

## 검증과 재현

s8 Node 테스트, 프런트엔드 테스트·빌드와 수정하지 않은 PH-CMS의 기존 PostgreSQL 회귀 테스트를 실행한다. 전체 연동 테스트는 s8에만 추가했다.

```bash
npm run build --prefix frontend
bash pi/bin/test-projectman-worker-pool.sh ../ph-cms
```

PH-CMS 의존성, postgres 컨테이너, Playwright Chromium이 필요하다. 테스트는 임시 DB·역할을 생성하고 종료 시 정리하며 실제 .env를 읽지 않는다. 모델과 Telegram API는 로컬 fixture다. 실제 HTTP 서버·Pi SDK·워커 소켓·Chromium으로 화면 승인, 결과·패치 보존, 개발 완료 통지, 링크 로그인, 매니저 검토와 사람의 최종 완료를 확인한다. 실제 Telegram 발송이나 운영 배포는 하지 않는다.

검증 결과: s8 기존 Node 회귀 148개와 매니저 검토 경로 7개(기존 6개 포함), 프런트엔드 56개 및 빌드, 원본 PH-CMS PostgreSQL 회귀 45개가 통과했다. 전체 연동 1개에서 알림 재시도·로그인 후 링크 유지·매니저 검토·사람의 최종 완료·의존 작업의 완료 전후 claim 조건을 확인했다.


## 완료 검토의견

완료 화면의 reviewComment는 s8 콘솔 전용 입력이며 PH-CMS에는 기존 complete.message로 전달한다. 최대 6,000자이며 선택 입력이다. 원본은 done으로 확정하고, completion_review 메시지를 매니저의 기존 inbox에 넣는다. 매니저는 추가 조치 없음·새 work 작성·질문을 판단한다. 새 work는 원본을 dependsOn으로 연결하며 사용자 실행 승인을 별도로 받는다.

로컬 completion-reviews 기록은 완료 API 호출 전에 저장한다. 완료와 로컬 전달은 분산 트랜잭션이 아니므로, 매니저 polling이 동일 UID/requestId/요청 지문의 서버 complete work_log와 done 결과를 확인해 전달을 복구한다. 매니저는 사용자 complete를 재실행하지 않는다. 같은 요청의 재시도는 기존 수신 기록을 덮어쓰지 않는다. 매니저 메시지 주입 직후 장애에는 재전달 가능성이 남으므로 sourceRef로 기존 후속 work를 확인한다.

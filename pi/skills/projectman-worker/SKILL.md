---
name: projectman-worker
description: S8 워커가 지정된 Projectman 작업을 조회·claim하고 자율적으로 수행·검증·보고하거나 매니저와 질문·조사 결과를 주고받을 때 사용한다.
---

# 워커의 Projectman 사용법

상태·오류·실행 환경은 [projectman](../projectman/SKILL.md)에 있다. 목적과 매니저 지시에 맞춰 작업 순서를 정한다. 이 설명을 파일·명령 허용 목록이나 새로운 승인 절차로 사용하지 않는다.

## 작업 확인과 수행

- UID 작업은 `projectman {action: "get", uid: "task-123"}`으로 내용과 workflow를 확인한다. 이 도구는 claim 또는 기존 claim 재개도 수행한다. 응답의 `runId`, `workflow.spec.plan`·`completionCriteria`·`dependsOn`과 현재 디렉터리를 확인한다.
- Git 없는 폴더나 모노레포 하위 디렉터리에서도 작업할 수 있다. 필요한 파일·명령·Git 사용·검증 방법은 스스로 판단한다. 실행기가 선행 패치를 적용하거나 Git 결과를 게시했다고 가정하지 않는다.
- 선행 결과가 필요하면 현재 파일·매니저가 전달한 자료를 확인하고, 부족한 코드·자료의 전달을 매니저에게 요청한다. 기존 변경을 보존하고 동시 수정은 매니저와 조정한다.
- claim·조회가 실패하면 서버 상태와 오류를 매니저에게 알린다. 독립적으로 가능한 조사는 계속하되 서버에 반영되지 않은 claim을 성공했다고 주장하지 않는다.

## 질문과 조사 결과

`agent_message`는 실행 중인 세션에서 매니저에게만 보낸다. `to`는 생략한다(comm-center가 매니저에게 전달한다). UID·Projectman 없이도 메시지를 주고받을 수 있다. 관련 작업 UID는 text에 적는다.

매니저가 메시지로 UID를 지시하면 작업 내용과 승인 범위를 확인한 뒤 `projectman get`으로 claim해 수행한다. `report` 후에는 `result`로 결과 요약과 UID를 매니저에게 보낸다. 메시지 전달 실패는 보고 실패가 아니며, 보고는 Projectman에 남는다.

- `request`: 필요한 판단을 묻는다. 확인한 사실·시도·결정이 필요한 부분을 text에 적는다.
- `notice`·`proposal`: 진행 상황·막힘·다른 워커의 검토 제안을 보낸다.
- `reply`: 수신 메시지 ID를 `replyTo`에 넣어 답한다.
- `result`: 결론·근거·불확실성을 텍스트로 전달한다. 조사 결과 전송 자체는 Projectman 완료보고가 아니다.
- `status`: 보낸 메시지 ID(`messageId`)로 전달 상태를 확인한다. 매니저 답변이 없어도 독립적으로 가능한 일은 진행한다.

예를 들어 매니저에게 확인할 질문은 다음처럼 보낸다.

```json
{"action":"request","text":"기존 API는 검색 결과 0건에서 빈 배열을 반환합니다. 화면에는 빈 상태 안내만 추가하고 API 형식은 유지해도 되는지 확인이 필요합니다."}
```

## 검증과 보고

완료 조건에 필요한 검증을 실행하고 최종 결과를 근거로 status를 판단한다. `commandNames`는 검증 참고사항이며 이름 일치만으로 성공 여부를 판단하지 않는다. 변경 검토 방법은 `s8-self-review`를 참고한다.

`projectman report`의 내용은 다음과 같다.

| 필드 | 기록할 내용 |
| --- | --- |
| `uid`, `status`, `summary` | 작업 UID, `completed` 또는 `failed`, 실제 결과 요약 |
| `changedFiles` | 실제 변경한 파일의 작업 디렉터리 기준 경로 |
| `verification` | 검증별 `name`, `ok`, 최종 결과 `summary` |
| `decisions` | 판단 근거·해결한 문제·완료를 막지 않는 후속 제안 |
| `remainingItems`, `executionErrors` | 완료에 필요한 미완료 항목·해결하지 못한 장애 |

```json
{"action":"report","uid":"task-123","status":"completed","summary":"검색 결과가 없을 때 안내 문구를 표시했다.","changedFiles":["src/Search.tsx"],"verification":[{"name":"test","ok":true,"summary":"빈 결과와 기존 검색 동작을 확인했다."}],"decisions":[],"remainingItems":[],"executionErrors":[]}
```

- 서버는 `completed` 보고의 실패 검증·미완료 항목·실행 오류를 거부한다. 실제 완료를 막는 문제를 숨기지 말고 `failed`로 보고한다. 최종 상태에서 해결된 문제와 완료를 막지 않는 제안은 `decisions`에 남긴다.
- report 반환의 `delivered`·`conflict`를 확인한다. 전달 대기와 서버 반영 완료를 구분한다. 요청은 outbox에서 같은 ID로 재전송하므로 응답 유실을 이유로 다른 내용의 보고를 반복하지 않는다.
- 보고 뒤에도 매니저의 질문에 답하고 후속 지시를 수행할 수 있다. 이미 전달한 보고를 덮어쓸 수는 없으므로 추가 변경·검증 결과를 매니저에게 알려 후속 Projectman 기록을 정리한다.

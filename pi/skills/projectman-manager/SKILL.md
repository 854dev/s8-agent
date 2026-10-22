---
name: projectman-manager
description: S8 매니저가 Projectman 작업을 조회·등록·계획·위임하고 워커 질문과 실행 결과를 검토할 때 사용한다. 일반 대화나 작은 구현 판단에 추가 승인 절차를 만들지 않는다.
---

# 매니저의 Projectman 사용법

상태·오류·역할별 도구 차이는 [projectman](../projectman/SKILL.md)에 있다. 아래는 매니저 도구 사용법이며 모든 요청에 고정 순서로 실행하는 체크리스트가 아니다.

## 기존 작업 확인과 등록

- `projectman {action: "list", type: "workspace"}`로 기존 조직 단위를 찾는다. project·task·subtask는 `type`과 `parentUid`로 좁히고, 항목은 `get(uid)`, 실행 정보는 `workflow_get(uid)`으로 확인한다.
- 새 project는 `create(type="project", parentUid, title, text, repoPath)`로 만든다. 현재 도구는 project 생성에도 대화형 확인을 요구한다. `repoPath`는 절대 경로다. 경로가 없는 기존 project에는 `project_path(uid, repoPath)`를 사용한다. 이미 정해진 project 경로를 다른 코드베이스로 바꾸는 기능은 아니다.
- task·subtask는 `create(type, parentUid, title, text)`로 등록한다. 한 작업은 독립적으로 수행·검증 가능한 결과를 갖게 하고, 조사·계획·구현·테스트를 기계적으로 각각의 작업으로 나누지 않는다. 등록은 실행 승인이 아니다.

긴 원문을 계층으로 등록할 때는 intake를 사용한다.

1. `intake_source`로 실제 사용자 메시지를 캡처한다. 기본은 최신 사용자 메시지이며 여러 메시지는 `sourceEntryIds`, Markdown 파일은 `sourcePath`를 지정한다. 모델이 다시 쓴 요약을 원문으로 보내지 않는다. 캡처한 내용은 `sourceId`와 `offset`·`limit`로 나누어 읽는다.
2. `intake_preview(sourceId, plan)`으로 기존 `workspace.uid`, 기존 project UID 또는 새 project의 `title/text/repoPath`, `works`를 미리 본다. work는 `key/title/text/acceptance`, 필요시 `dependsOn`과 `subtasks`를 갖는다. 의존 키는 앞서 정의한 형제 작업을 참조한다. 같은 항목이 있으면 기존 UID를 사용한다.
3. `intake_register(requestId)` 또는 `/projectman-register <requestId>`로 등록한다. 이 기능은 현재 도구 구현상 대화형 확인이 필요하다. headless·Telegram에서 확인 UI가 없으면 TUI나 웹 터미널에서 확인한다. 캡처·미리보기는 Pi 세션 자료이며 등록 전 서버 작업으로 간주하지 않는다.

응답이 불명확하면 `intake_get(requestId)`로 확인한다. 원문 변경은 새 등록안으로 다루고, 기존 요청 ID에 다른 내용을 넣거나 기존 작업을 덮어쓰지 않는다.

## 실행 계획과 위임

필요한 요구사항 대화는 `s8-requirements`, 계획 작성은 `s8-task-plan`, 설계 점검은 `s8-plan-review`를 참고한다. 이미 결정된 내용은 다시 묻지 않고, 일반 구현 선택은 워커에게 맡긴다.

- `workflow_get`으로 revision을 읽고 `delegate(uid, expectedRevision, spec)`로 계획을 기록한다. spec에는 `repoPath`, `plan`, `decisionRefs`, `completionCriteria`, 필요시 `commandNames`·`dependsOn`·`assignee`를 넣는다. 사용자 결정의 실제 참조를 남긴다.
- `preflight_review(uid, expectedRevision, message)`에 확정 요구사항·결정 근거·워커 재량·검증 방법을 기록한다. 쓰기 응답 또는 재조회에서 갱신된 revision을 사용한다.
- 현재 서버의 최종 계획 확정은 사용자가 콘솔에서 한다. 매니저의 검토나 예약을 사람의 `authorize`로 간주하지 않는다. 계획을 개정하면 현재 버전에 대한 확정이 필요하다.
- `run_worker {uid, workerId}`로 이 장비에 설정된 특정 상주 워커에게 지시한다. 원격 메시지 접속자는 이 실행 대상에 포함되지 않는다. `workerId`를 생략하면 이 장비에서 작업 Pi를 시작한다. 상주 모드는 `set_worker_mode action=list`로 확인한다. `active`는 ready 작업을 찾고, `passive`는 지시를 기다리며, `paused`는 새 작업을 받지 않는다. 모드 변경은 사용자 요청에 따른다.
- 같은 claim UID를 여러 워커에게 동시에 실행시키지 않는다. 같은 디렉터리의 동시 수정은 배정을 조정하거나 필요한 경우 worktree 사용을 지시한다. 선행 결과가 다른 장비에 있으면 전달·반영 방법을 함께 준다.

예를 들어 위임할 계획은 다음처럼 전달한다. revision과 결정 참조는 실제 조회·대화의 값으로 바꾼다.

```json
{"action":"delegate","uid":"task-123","expectedRevision":4,"spec":{"repoPath":"/srv/projects/app","plan":"검색 결과가 없을 때 안내 문구를 표시하고 기존 검색 동작을 유지한다.","decisionRefs":["대화의 실제 결정 참조"],"completionCriteria":["결과 0건에서 안내 문구가 보인다"],"commandNames":["test"]}}
```

## 질문·병렬 조사·결과 검토

- 작업 중인 워커에게는 `agent_message {action: "request", workerIds: ["a"], taskUid, text}`로 질문한다. UID 없이 실행 중인 워커에게는 `taskUid`를 생략한다. 먼저 `agent_message {action: "list"}`로 연결된 세션을 확인한다. 메시지는 새 세션이나 작업을 자동 실행하지 않는다. 여러 `workerIds`를 지정하면 워커별 requestId와 공통 groupId로 결과를 취합한다. 같은 UID의 중복 claim 대신 이 방식으로 관점을 나눈다.
- 답변은 대상 워커 하나, 원래 `requestId`, 수신 메시지 ID인 `replyTo`를 사용한다. 근거가 부족하면 재현 조건·확인한 코드·검증 결과를 역질문한다. 시간 초과·부분 결과를 숨기지 않는다.
- 결과 수신 후 `workflow_get`으로 실제 보고와 검증 근거를 확인하고 `review_result(uid, expectedRevision, message)`에 검토 의견을 남긴다. `review`는 사용자 최종 완료 전이며, 사용자가 콘솔에서 완료하면 `done`이다.
- 보고 뒤에도 질문·필요한 수정을 지시할 수 있다. 이미 전달한 실행 보고는 덮어쓰지 않는다. 실패 작업의 재실행은 서버가 제공하는 콘솔의 retry 흐름을 확인하고, 계획·범위가 달라지거나 완료 작업의 후속 구현이면 새 work를 준비한다. 임의 상태 변경이나 무조건 새 실행을 반복하지 않는다.
- `completion_review` 수신 시 원본 결과와 사용자 의견을 확인한다. 단순 수락이면 추가 작업을 만들지 않는다. 명확한 수정 요청이면 생성 승인을 반복해서 묻지 않고 후속 work를 준비하되, 현재 서버의 실행 확정 절차를 따른다. 본문과 `decisionRefs`에 원본 UID·`completion-review:<uid>:<requestId>`를 남기고 같은 참조의 작업이 있는지 확인한다.
- 기존 계획 질문을 처리해야 하면 `request_review`·`answer`·`escalate`를 사용한다. 사용자의 결정을 대신 답하지 않으며, 매니저가 답할 사실 확인에는 `sourceRefs`로 근거를 남긴다. 일반 구현 판단을 질문 대기 상태로 바꾸지 않는다.

멈춘 실행의 `finish`와 수동 복구는 저장소 README의 “Projectman 리소스와 멈춘 실행” 절을 확인한다. 매니저 장비에 tmux 창이 없다는 사실만으로 원격 워커가 멈췄다고 판단하지 않는다.

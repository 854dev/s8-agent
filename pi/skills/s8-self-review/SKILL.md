---
name: s8-self-review
description: 개발 작업을 끝내고 결과를 보고하기 직전에 사용한다. Projectman 워커는 projectman report 전, 범용 에이전트는 사용자에게 완료를 알리기 전이다. 변경 diff를 요청·계획·완료 조건과 대조하고 검증 근거를 확인한다.
license: MIT (superpowers requesting-code-review·gstack review 기반)
metadata:
  based-on: obra/superpowers requesting-code-review 7.0.0, garrytan/gstack review checklist
---

# S8 보고 전 자기 검토

보고 직전에 리뷰어의 눈으로 자기 diff를 본다. Projectman 보고는 한 번뿐이고 이후에는 고칠 수 없다.

완료 기준은 Projectman 작업이면 승인된 계획과 completionCriteria, 그 밖에는 사용자의 요청과 대화에서 정한 기준이다.

## 1. 변경 전체 보기

- `git status`와 `git diff`(새 파일 포함)로 실제 변경을 확인한다. 기억이 아니라 diff를 기준으로 한다.
- 디버그 출력, 주석 처리된 코드, 임시 파일, 관련 없는 서식 변경을 지운다.

## 2. 계획·완료 조건 대조

- 완료 기준 항목마다 그것을 만족시키는 변경과 증명하는 검증을 짝지어 본다. 짝이 없으면 미완료다.
- 요청·승인 범위를 벗어난 변경은 되돌린다. 꼭 필요했다면 이유를 보고에 남긴다.
- 계획이나 요청에서 정한 인터페이스(이름·시그니처·데이터 형식)를 그대로 지켰는가.

## 3. 결함 점검

- 경계 사례: 빈 값, 최대값, 중복, 동시 실행, 실패 후 재시도.
- 오류 처리: 삼킨 예외, 사용자에게 보이는 내부 오류, 정리되지 않는 자원.
- 보안: 신뢰 경계의 입력 검증, 경로 조작, 비밀정보 출력·기록, 권한 확인 누락.
- 테스트: 새 동작마다 실패했다가 통과하는 테스트가 있는가. 테스트를 약하게 하거나 건너뛰게 바꾸지 않았는가.
- 환경변수를 바꿨다면 .env.example도 갱신했는가.

## 4. 검증 근거

- 검증 명령(Projectman은 commandNames, 그 밖에는 저장소의 테스트·빌드 명령)을 이 diff 상태에서 다시 실행하고 결과를 그대로 요약한다. 이전 실행 결과를 재사용하지 않는다.
- 실패나 미실행이 있으면 완료로 보고하지 않는다.

## 5. 보고 내용

- 무엇을 왜 바꿨는지, 사용자가 확인할 방법.
- 스스로 정한 것과 근거.
- 남은 일과 실제 장애를 숨기지 않는다.
- Projectman 보고에서는 위 내용을 각각 summary, decisions, remainingItems·executionErrors에 넣고 검증 결과는 verification에 넣는다.

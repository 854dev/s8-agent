---
name: s8-operations
description: s8의 Pi 실행 환경, tmux, frontend, 라우터 또는 지식베이스 API를 설치하거나 운영·점검할 때 사용한다.
---

# s8 운영

## 사용 시점

s8의 Pi 실행 환경, tmux, frontend, 라우터 또는 지식베이스 API를 설치·실행·점검할 때 사용한다.

## 절차

- `../s8-agent/README.md`의 인프라·운영 절을 먼저 읽는다.
- 상태 확인은 frontend, 라우터, 지식베이스 API를 분리해서 수행한다.
- 라우터 경로 변경 후 `node --test pi/test/router.test.mjs`를 실행한다.
- 서비스 중단을 유발하는 `start-infra.sh` 재실행과 `s8-infra` 세션 종료는 사용자의 명시적 요청이나 승인 후 실행한다.
- 인증정보와 `.pi-runtime/`, `.s8-runtime/` 내부 파일을 읽거나 결과에 복사하지 않는다.
- 변경한 파일과 검증 결과를 완료 보고에 남긴다.

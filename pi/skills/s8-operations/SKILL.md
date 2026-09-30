---
name: s8-operations
description: s8의 Pi 실행 환경, tmux, frontend, Docker Compose, Nginx 또는 지식베이스 API를 설치하거나 운영·점검할 때 사용한다.
---

# s8 운영

## 사용 시점

s8의 Pi 실행 환경, tmux, frontend, Docker Compose, Nginx 또는 지식베이스 API를 설치·실행·점검할 때 사용한다.

## 절차

- `../s8-agent/INFRASTRUCTURE.md`와 `../s8-agent/OPERATIONS.md`를 먼저 읽는다.
- 상태 확인은 frontend, Docker Compose, Nginx, 지식베이스 API를 분리해서 수행한다.
- Nginx 설정 변경 후 Compose의 `nginx -t` 명령을 실행한다.
- 서비스 중단을 유발하는 Compose `down`은 사용자의 명시적 요청이나 승인 후 실행한다.
- 인증정보와 `.pi-runtime/`, `.s8-runtime/` 내부 파일을 읽거나 결과에 복사하지 않는다.
- 변경한 파일과 검증 결과를 완료 보고에 남긴다.

# s8 Pi 기반 구현 계획 v1

## 목표

- `854_md`를 지식과 작업 결과의 원본으로 유지한다.
- Pi와 프로젝트 도구를 npm 잠금 파일과 `pi/` 설정으로 재현한다.
- 인증정보와 세션을 Git에서 분리한다.
- 웹 콘솔은 에이전트 기능을 중복 구현하지 않고 문서와 운영 상태를 조회한다.

## 완료된 기반 작업

- Pi를 `pi/package.json`의 프로젝트 로컬 의존성으로 고정
- `pi/package-lock.json`을 이용한 `npm ci` 설치 경로 제공
- 저장소 루트에서 Pi를 실행하고 장비별 상태를 분리하는 `start-pi.sh` 제공
- `pi/`에 settings, extension, skill, 시스템 지침 구성
- `.pi-runtime/`을 Git과 에이전트 도구에서 차단된 장비별 런타임으로 사용
- `.pi-runtime/`에 인증정보와 세션 분리
- `.s8-runtime/`에 로그와 업로드 분리
- tmux, frontend, Docker Compose, Nginx는 표준 명령을 직접 사용
- 인프라 명령을 감싸던 래퍼 스크립트 제거

## 다음 단계

### Phase 1: 운영 검증

- 사용할 모델 provider에서 `/login` 수행
- `854_md/AGENTS.md`와 `pi/APPEND_SYSTEM.md` 로딩 확인
- 보호 경로 쓰기 차단 확인
- 세션 생성, 종료, `--continue` 재개 확인
- 다른 장비에서 clone과 `npm ci` 재현 확인

### Phase 2: 필요한 도구만 확장

- 반복 작업이 실제 필요하면 OS scheduler 또는 전용 extension 설계
- 외부 메시징이 필요하면 별도 인증·승인 경계를 정의한 통합 추가
- 작업 상태 저장소가 필요하면 SQLite 등 별도 데이터 계층과 접근 API 설계
- 외부 패키지는 소스와 권한을 검토하고 정확한 버전으로 고정

### Phase 3: 운영 콘솔 연결

- Pi 세션을 직접 노출하지 않고 필요한 요약만 표시
- 별도 작업 저장소가 연결되면 조회 전용 API와 화면 추가
- 서비스 상태와 승인 대기 항목이 필요할 때만 API 추가

## 구현 원칙

- Pi 코어에 없는 기능을 이름만 바꿔 존재하는 것처럼 문서화하지 않는다.
- 재현 가능한 설정은 Git에, credential과 장비 상태는 `.pi-runtime/`과 `.s8-runtime/`에 둔다.
- extension은 작게 유지하고 테스트 가능한 정책만 코드로 강제한다.
- 서비스 조작과 에이전트 실행을 분리한다.

## Verify

```bash
npm ci --ignore-scripts --prefix pi
./start-pi.sh --version
bash -n start-pi.sh
git diff --check
```

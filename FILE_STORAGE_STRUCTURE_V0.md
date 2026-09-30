# s8 데이터 저장 경계 v1

## 원칙

- `854_md`의 Markdown과 프로젝트 파일은 지식과 프로젝트 문서의 원본이다.
- 작업 상태, 실행 이력, 예약 정보는 Markdown 파일로 저장하지 않는다.
- 작업 데이터는 향후 SQLite 등 별도 데이터 저장소로 분리한다.
- 데이터 저장소가 구현되기 전에는 Pi 세션 외에 별도 작업 상태를 만들지 않는다.
- 인증정보, 세션, 캐시, 로그는 Git에 포함하지 않는다.

## 저장소에 포함하는 경로

```text
pi/
├── settings.json
├── APPEND_SYSTEM.md
├── extensions/
├── skills/
├── package.json
└── package-lock.json
```

- `pi/`: 모든 장비가 공유하는 Pi 패키지, 설정과 검토된 실행 코드
- 프로젝트 문서: 사람이 검토하고 Git으로 보존할 지식과 설계

## 저장소에서 제외하는 경로

```text
.s8-runtime/
├── state/
├── logs/
└── data/uploads/

.pi-runtime/
├── auth.json
├── sessions/
├── cache/
└── settings.json
```

- 모델 credential과 로그인 상태
- Pi 세션과 캐시
- 프로세스 상태와 로그
- 업로드 파일

## 향후 작업 데이터 저장소

별도 저장소 도입 시 다음 경계를 유지한다.

- 작업 상태와 실행 이력은 지식 문서와 분리한다.
- SQLite를 사용하면 스키마와 migration은 코드로 관리한다.
- 데이터 파일은 기본적으로 `.s8-runtime/` 아래에 두고 Git에 포함하지 않는다.
- 웹 콘솔은 직접 파일을 읽지 않고 전용 API를 사용한다.
- credential과 세션 원문은 작업 데이터에 복사하지 않는다.
- 백업, 동기화, 충돌 정책을 정한 뒤 여러 장비에서 같은 데이터를 사용한다.

## 보안 경계

- 지식베이스 API와 에이전트 도구는 `.pi-runtime/`, `.s8-runtime/`, `.git/`, 비밀정보 경로에 접근하지 않는다.
- `pi/extensions/`는 실행 코드이므로 일반 문서보다 엄격하게 검토한다.
- 별도 작업 저장소에 비밀정보와 모델 credential을 저장하지 않는다.

## Verify

```bash
test -f pi/settings.json
test -f pi/package-lock.json
test -x start-pi.sh
git check-ignore .s8-runtime/example
```

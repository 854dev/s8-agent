# S8 회귀 검증 (2026-10-18)

확정 계획 기반 Projectman workflow v2 변경을 main 반영 전에 검증했다. PH-CMS의 대응 구현은 dev 커밋 `fc59ea7`에 있다. 저장 타입 task/subtask, workspace별 프로젝트 동일성, 태스크 직접 실행과 부모 grant 불필요 정책을 유지한다.

## 실행 결과

| 대상 | 명령 | 결과 |
| --- | --- | --- |
| Pi·개발 감독·Projectman·세션 실행기 | `node --test pi/test/*.test.mjs` | 118 통과 |
| 프런트엔드 | `npm run test:run --prefix frontend` | 44 통과 |
| Telegram·터미널 게이트웨이 | `node --test apps/telegram-gateway/*.test.mjs apps/terminal-gateway/*.test.mjs` | 17 통과 |
| KB 브라우저 | `npm test --prefix apps/kb-browser` | 3 통과 |
| MCP 허브 | `npm test --prefix apps/mcp-hub` | 6 통과 |
| PH-CMS 실제 HTTP 클라이언트·PostgreSQL 계약 | PH-CMS `vitest.projectman-plan.config.ts` | 12 통과 |

S8 테스트 총 188개와 별도 API 계약 12개가 모두 통과했다. 프런트엔드, KB 브라우저, MCP 허브의 각 build 스크립트와 `git diff --check`도 통과했다. 게이트웨이 테스트는 실제 PTY 연결과 연결 종료 후 세션 보존까지 검증했다. API 계약은 임시 PostgreSQL 55439 포트와 테스트 전용 DB에서 실행했으며 운영 DB와 실제 .env는 사용하지 않았다.

개발 감독 테스트는 확정 계획 검사, 독립 태스크 실행, Git 의존 패치 조합과 재개, 검증 실패 보존, 취소·예산 소진 및 질문 없는 구조화 결과를 검증한다. 설치되지 않은 서비스 의존성은 기존 lockfile 기준 npm ci로 설치한 뒤 재실행했다. 의존성/lockfile 변경은 없다.

## 남은 검증 한계와 기존 경고

- Docker 소켓 접근이 permission denied이므로 실제 개발 컨테이너와 유료 모델을 결합한 종단 실행은 수행하지 않았다. 운영 서비스 재시작·배포도 수행하지 않았다.
- 프런트엔드 lint는 오류 없이 종료했으나 기존 경고 3건이 있다. ProjectmanPage의 컴포넌트 외 export 2건과 답변 draft 초기화 effect의 dependency 경고 1건이며 이번 변경 전에도 같은 코드에 존재한다.
- 기존 lockfile 설치 시 npm audit가 KB 브라우저 2건(high), MCP 허브 17건(low 5, moderate 6, high 6)을 보고했다. 이번 기능 변경에 따른 의존성 추가는 없으며 보안 경고 해결은 별도 의존성 업데이트가 필요하다.
- PH-CMS workflow v2와 함께 사용해야 하며 기존 v1 실행 승인은 새 계획 확정으로 자동 전환하지 않는다.

빌드 산출물 dist/build/test-dist 및 tsbuildinfo는 gitignore에 포함하고 기존 추적 KB 브라우저 dist 파일은 Git 추적에서 제거한다. Pi의 lastChangelogVersion 1.3.0은 설치된 Pi 버전의 변경 기록 확인 메타데이터다.

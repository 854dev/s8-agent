# s8 MVP

Vite + React + Mantine 기반의 `s8 (scheduler 854)` 프론트엔드 MVP.

## 현재 포함 화면

- 상단 요약 대시보드
- 그룹별 작업 카드 보드
- 표 기반 작업 리스트
- 최근 3턴 로그 패널
- 유휴시간 보충 큐 패널
- 읽기 전용 지식베이스 브라우저
    - 파일 트리와 lazy folder loading
    - 계획·작업내역 검색과 최근 문서
    - Markdown reader
    - 데스크톱 split view와 모바일 목록/reader 전환

## 실행
```bash
cd frontend
npm ci
npm run dev -- --host 0.0.0.0 --port 4178
```

Tailscale 환경에서 다른 기기에서 보려면 로컬 장비의 Tailscale IP로 접속한다.

예:
```text
http://100.x.y.z:4178
```

## 빌드
```bash
cd frontend
npm run build
```

## 지식베이스 브라우저

지식베이스 화면은 Nginx prefix 뒤의 `/s8/knowledge-base`에서 연다.

```text
http://127.0.0.1/s8/knowledge-base
```

프론트엔드는 같은 origin의 `/api/docs/*`를 사용한다. Vite dev/preview 서버로 직접 접속하는 경우에도 `/api` 요청은 로컬 Nginx로 proxy된다. 작업 상태와 실행 이력은 Markdown 지식 문서와 분리하며, 별도 데이터 저장소가 연결되기 전에는 화면에서 제공하지 않는다.

## 테스트와 lint

```bash
cd s8
npm run test:run
npm run lint
npm run build
```

## 메모
- 현재는 정적 MVP 화면이다.
- 실제 작업 실행기, `854_md` 수정 API, 승인 처리, 로그인은 아직 연결하지 않았다.

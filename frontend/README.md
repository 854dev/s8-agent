# S8 웹 콘솔

Vite + React + Mantine 기반의 `s8 (scheduler 854)` 웹 프론트엔드다. 기본 경로는 `/s8/`이며, 지식베이스·파일 업로드·호스트 터미널과 샘플 작업 대시보드를 제공한다.

## 현재 포함 화면

- `/s8/`: 요약 대시보드, 그룹별 작업 카드·표, 최근 로그, 승인·유휴시간 큐. 현재 샘플 데이터이며 실제 작업 실행 상태와 연결되지 않음
- 읽기 전용 지식베이스 브라우저
    - 파일 트리와 lazy folder loading
    - 계획·작업내역 검색과 최근 문서
    - Markdown reader
    - 데스크톱 split view와 모바일 목록/reader 전환
- `/s8/upload`: 파일 선택·드래그 업로드, 결과·오류 표시. `/api/files/upload` 사용
- `/s8/terminal`: xterm.js 기반 호스트 셸·S8 tmux 세션 접속, 세션 전환·재연결, 모바일 보조 키·붙여넣기·전체화면·글자 크기 조절

## 실행

`s8-agent` 루트에서 실행한다.

```bash
npm ci --prefix frontend
npm run dev --prefix frontend -- --host 127.0.0.1 --port 4178
```

로컬 화면은 `http://127.0.0.1:4178/s8/`에서 연다. 다른 장치에서는 Tailscale IP에 바인딩한 Nginx를 통해 `http://<Tailscale-IP>/s8/`로 접속한다. 웹 터미널은 호스트 사용자 권한을 가지므로 전체 인터페이스나 공인망에 노출하지 않는다.

- 지식베이스·업로드: `apps/kb-browser`와 Nginx 필요
- 터미널: `apps/terminal-gateway`와 tmux 필요
- Vite dev/preview는 `/api/terminal`을 `127.0.0.1:8790`으로, 나머지 `/api`를 로컬 Nginx `http://127.0.0.1`로 proxy한다. API 사용 전 해당 backend와 Nginx의 접근 가능 여부를 확인한다.
- backend 실행·접근 제한·복구는 [웹 터미널 운영 문서](../apps/terminal-gateway/README.md)를 참고한다.

## 빌드
```bash
npm run build --prefix frontend
npm run preview --prefix frontend -- --host 127.0.0.1 --port 4178
```

빌드 결과는 `frontend/dist/`에 생성된다. Nginx를 통한 서비스에서는 호스트의 dev/preview 서버가 4178 포트에서 실행되어야 한다.

## 지식베이스 브라우저

지식베이스 화면은 Nginx prefix 뒤의 `/s8/knowledge-base`에서 연다.

```text
http://127.0.0.1/s8/knowledge-base
```

프론트엔드는 같은 origin의 `/api/docs/*`를 사용한다. 지식베이스는 읽기 전용이며 문서 편집 API는 제공하지 않는다. 예약 상태는 별도 스케줄러 런타임에, Projectman 작업·로그는 PH-CMS에 저장되며 이 대시보드와 자동 연결되지는 않는다.

## 터미널 폰트

- Yazi 등의 아이콘은 `public/fonts/SymbolsNerdFontMono-Regular.ttf`를 같은 서버에서 제공한다. 외부 CDN이나 클라이언트의 Nerd Font 설치가 필요 없다.
- Nerd Fonts v3.4.0의 Symbols Only Mono를 사용하며 배포 라이선스는 `public/fonts/LICENSE`에 포함한다.
- 아이콘 폰트는 유니코드 Private Use 영역에만 적용하고, 영문·한글·다른 언어는 운영체제의 고정폭 및 CJK 폰트로 대체한다. 글리프 지원은 클라이언트에 설치된 폰트에 따라 달라진다.
- 폰트 다운로드와 무관하게 셸에 즉시 연결하며, 아이콘 폰트 로드 후 화면 크기와 표시를 갱신한다. 다운로드 실패 시 시스템 폰트를 유지하고, 셸 프로세스나 서버 설정은 변경하지 않는다.

## 테스트와 lint

`s8-agent` 루트에서 실행한다.

```bash
npm run test:run --prefix frontend
npm run lint --prefix frontend
npm run build --prefix frontend
```

## 현재 제약

- 작업 카드·로그·승인 큐는 샘플 데이터다. 예약 CRUD는 Pi의 `scheduler` 도구, 예약 정지·재개·배치 중단은 Telegram `/jobs`를 사용한다.
- 별도 웹 로그인·승인 처리·지식베이스 문서 편집은 제공하지 않는다. Tailscale ACL을 접근 권한 경계로 사용한다.
- 여러 터미널 접속자는 같은 셸·세션의 입력과 화면 크기를 공유한다. 브라우저를 닫아도 tmux 세션은 유지된다.
- 폰트 글리프·모바일 키보드·전체화면 동작은 실제 클라이언트 환경에서도 확인해야 한다.

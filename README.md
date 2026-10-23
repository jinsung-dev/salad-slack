# Chatter

10~50명 규모 제품 개발 팀을 위한 사내 메신저. 팀의 대화와 결정이 한 곳에 남고,
필요한 사람에게 필요한 순간에만 알림이 가도록 하는 것이 목표다. Phase 0~5로 나눠 만들고,
각 Phase는 출시 가능한 상태와 측정 가능한 게이트로 끝난다.

- 제품 요구사항: [Chatter PRD — Phase별 제품 요구사항](https://claude.ai/artifact/GEERZndLepkFjwF663e3rj)
- 진행 현황: [docs/roadmap.md](docs/roadmap.md)

## 현재 상태

Phase 0~2 구현과 Phase 3의 P0·P2가 끝났고, 사내 테스트 서버(ngrok)에서 돌아간다.
남은 일은 두 가지다.

- Phase 2 도그푸딩 게이트: 도그푸딩 팀이 2주 동안 업무 대화의 90% 이상을 Chatter에서 한다.
- Phase 3 P1 결정: 데스크톱 앱과 자동 업데이트. macOS 코드 서명(Apple Developer 계정)이 필요하다.

| Phase | 내용 | 상태 |
| --- | --- | --- |
| 0 리서치 | 데스크톱 셸 구조 분석 | 셸 완료, 웹 클라이언트 분석 미착수 |
| 1 MVP | 로그인, 공개 채널, 실시간 메시지, 히스토리, 미읽음, 재연결, 기본 서식 | 완료 |
| 2 대화 | 스레드, DM·그룹 DM, 비공개 채널, 멘션, 수정·삭제, 리액션, 접속 상태, 입력 중 표시, 서버 수평 확장, Google 로그인 | 구현 완료, 도그푸딩 게이트 진행 전 |
| 3 생산성 | 파일 업로드, 검색, 알림 설정, 웹 푸시, 저장한 메시지 | P0·P2 완료, 데스크톱 앱(P1) 결정 대기 |
| 4 플랫폼 | 멀티 워크스페이스, 초대, 권한, 웹훅, 봇, 슬래시 커맨드 | 예정 |
| 5 고급 | 음성·화면 공유, SSO, 보존 정책, 감사 로그, 모바일 | 후보 |

## 스택

| 영역 | 기술 |
| --- | --- |
| `apps/web` | React 19, Vite, TanStack Query, React Router |
| `apps/server` | Fastify 5, `@fastify/websocket`, Drizzle ORM, Postgres 17(`pg_trgm`), Redis 7(ioredis), web-push |
| `packages/shared` | zod 요청 계약, 응답과 실시간 이벤트 타입 |
| `e2e` | Playwright |

## 시작하기

Node 24 이상, pnpm 11, Docker가 필요하다.

```bash
pnpm install
cp .env.example .env
pnpm db:up      # Postgres localhost:54329 (chatter_test DB도 생성), Redis localhost:56379
pnpm dev        # 서버 :3001 (시작할 때 마이그레이션 실행), 웹 :5173
```

http://localhost:5173 을 브라우저 프로필 두 개로 열면 두 사용자로 대화해 볼 수 있다.
로컬에서는 "Google 계정으로 로그인"이 가짜 로그인 화면으로 이어지고, 아무 이메일이나 입력하면 된다.
`.env.example`의 `ALLOWED_EMAIL_DOMAINS=saladlab.co`가 켜져 있으면 `@saladlab.co` 이메일만 통과한다.

## 명령어

루트에서 실행한다.

| 명령어 | 하는 일 |
| --- | --- |
| `pnpm dev` | 서버(tsx watch)와 웹(Vite) 개발 서버를 함께 실행 |
| `pnpm db:up` / `pnpm db:down` | Postgres·Redis 컨테이너 시작 / 중지 |
| `pnpm typecheck` | 모든 패키지 타입 검사 |
| `pnpm test` | 서버 통합 테스트(실제 Postgres·Redis, 서버 2대 클러스터) + 웹 단위 테스트. `pnpm db:up` 필요 |
| `pnpm test:e2e` | Playwright E2E. 별도 프로덕션 빌드를 :3101에 띄우고 `chatter_e2e` DB를 지우고 시작. 로컬 Google Chrome 필요 |
| `pnpm build` | 웹 앱 프로덕션 빌드(`apps/web/dist`) |
| `pnpm start` | 웹을 빌드한 뒤 서버 하나로 웹 + API + WebSocket을 :3001에서 서비스 |
| `pnpm db:generate` | `schema.ts` 변경으로 마이그레이션 SQL 생성 |
| `pnpm --filter @chatter/server db:reset` | `.env`의 DB를 비우고 다시 마이그레이션 |
| `pnpm --filter @chatter/server vapid` | 웹 푸시용 VAPID 키 생성 |

테스트 하나만 실행하기:

```bash
pnpm --filter @chatter/server exec vitest run test/phase2.test.ts   # 서버 파일 하나
pnpm --filter @chatter/server exec vitest run -t "테스트 이름 일부"   # 이름으로
pnpm --filter @chatter/web exec vitest run src/cache.test.ts        # 웹 파일 하나
pnpm exec playwright test -g "테스트 이름 일부"                       # E2E
```

서버 테스트는 DB 스키마 하나를 공유하므로 파일을 순서대로 실행한다.
다른 DB·Redis를 쓰려면 `TEST_DATABASE_URL`, `TEST_REDIS_URL`을 지정한다.

## 환경 변수

`.env`는 이미 설정된 환경 변수를 덮어쓰지 않는다.

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://chatter:chatter@localhost:54329/chatter` | Postgres 연결 |
| `REDIS_URL` | `redis://localhost:56379` | Redis 연결 |
| `REDIS_PREFIX` | `chatter:` | Redis 키·채널 접두사. 여러 배포가 Redis 하나를 나눠 쓸 때 |
| `HOST` / `PORT` | `127.0.0.1` / `3001` | 서버 주소. `0.0.0.0`이면 다른 기기 접속 허용 |
| `COOKIE_SECURE` | `false` | HTTPS로 서비스할 때 `true` |
| `TRUST_PROXY` | `false` | 리버스 프록시 뒤에서 `X-Forwarded-For` 사용 |
| `ALLOWED_EMAIL_DOMAINS` | 비어 있음(모두 허용) | 로그인 허용 도메인, 쉼표로 구분 |
| `AUTH_RATE_LIMIT_PER_MINUTE` | `10` | IP당 분당 로그인 시도 수 |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | 없음 | 실제 로그인 제공자. 비우면 로컬 가짜 제공자(루프백 주소에서만 실행 가능) |
| `PUBLIC_URL` | 요청에서 추론 | 사람들이 여는 주소. Google 리디렉트 URI와 일치해야 함 |
| `FILE_STORAGE_DIR` | `data/uploads` | 첨부 파일 저장 위치(서버 로컬 디스크) |
| `FILE_MAX_BYTES` | `26214400` (25MB) | 파일당 최대 크기 |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | 없음 | 웹 푸시. 비우면 푸시 꺼짐. 키를 바꾸면 기존 구독이 끊김 |
| `WEB_DIST` | `apps/web/dist` | 서버가 같은 주소로 서비스할 웹 빌드 |

## 사용법

### 로그인

회사 Google 계정(`saladlab.co`)으로 로그인한다. 비밀번호는 없고, 세션은 30일 유지된다.

### 채널과 DM

- 사이드바의 **+ 채널 만들기**로 채널을 만든다. 이름에 한글을 쓸 수 있다(예: `개발팀`). 같은 이름은 만들 수 없다.
- 사이드바 **둘러보기**에서 공개 채널을 미리 보고 **채널 참여**로 들어간다. 참여 전에는 읽기만 가능하다.
- 비공개 채널은 초대된 멤버에게만 보인다. 비멤버에게는 존재 자체가 드러나지 않는다.
- **+ 새 메시지**로 1:1 또는 최대 8명 그룹 DM을 시작한다. 같은 멤버 구성이면 같은 대화방으로 이어진다.
- 읽지 않은 메시지 수와 나를 부른 멘션 수가 사이드바에 따로 표시된다.

### 메시지 보내기

- `Enter`로 전송, `Shift+Enter`로 줄바꿈. 전송에 실패하면 `Enter`로 다시 시도한다.
- `@`를 입력하면 이름 자동완성이 뜬다(`↑`/`↓`로 고르고 `Enter`/`Tab`으로 선택). `@channel`은 대화 참여자 모두에게 알린다.
- 서식: `*굵게*`, `_기울임_`, `~취소선~`, `` `코드` ``, ` ``` `로 감싼 코드 블록. URL은 자동으로 링크가 된다. HTML은 해석하지 않고 그대로 보인다.
- 메시지에 마우스를 올리면 리액션 추가, 스레드에 답글, 저장(🔖), 수정, 삭제 버튼이 나온다. 수정과 삭제는 작성자만 할 수 있다.

### 스레드

메시지의 **스레드에 답글**로 오른쪽 스레드 패널을 연다. 답글을 채널에도 함께 보낼 수 있다.
스레드 답글은 나를 멘션했거나 내 스레드에 달린 경우에만 알림이 온다.

### 파일

첨부 버튼, 드래그 앤 드롭, 붙여넣기로 파일을 올린다. 이미지는 대화 안에 미리보기로,
다른 파일은 다운로드로 표시된다. 파일당 최대 25MB이고, 대화 참여자만 받을 수 있다.

### 검색

사이드바의 **메시지 검색** 창에서 메시지를 찾는다. 띄어 쓴 단어가 모두 들어간 메시지를 찾고, 한국어 부분 일치를 지원한다.
대화, 보낸 사람, 기간으로 좁힐 수 있다. 내가 볼 수 있는 대화만 검색된다.

### 알림

- 대화별 알림 수준: 모든 메시지 / 멘션만 / 끄기.
- 사이드바 **설정**에서 데스크톱 알림(웹 푸시)을 켜고 방해 금지 시간을 정한다.
- Chatter 탭을 보고 있을 때는 푸시를 보내지 않는다. 알림을 누르면 해당 대화나 스레드로 이동한다.
- 서버에 VAPID 키가 설정돼 있어야 웹 푸시가 동작한다.

### 저장한 메시지

메시지에 마우스를 올리고 🔖를 누르면 사이드바의 **저장한 메시지**에 모인다.

## 사내 배포

- 사무실 네트워크에서 동료와 쓰기: [docs/lan-testing.md](docs/lan-testing.md)
- 실제 Google 로그인 설정: [docs/google-sign-in.md](docs/google-sign-in.md)

Google은 HTTPS 도메인으로만 리디렉트를 허용하므로, 다른 기기에서 접속하려면 HTTPS 주소(현재 ngrok)가 필요하다.
가짜 로그인 제공자는 `HOST`가 루프백이 아니면 서버가 시작을 거부한다.

## 스키마 변경

`apps/server/src/db/schema.ts`를 고친 뒤 `pnpm db:generate`를 실행하고,
`apps/server/drizzle/`에 생긴 파일을 함께 커밋한다. 마이그레이션은 서버 시작 시 적용된다.

## 설계 메모

- 쓰기는 REST로만 하고, WebSocket은 서버 이벤트를 내려보내는 데만 쓴다. 클라이언트는 소켓으로
  일시적인 신호(입력 중, 활동/자리비움)만 보내고 저장되는 쓰기는 보내지 않는다. 그래서 모든 쓰기는
  검증된 경로 하나를 지난다. 재연결 후에는 다시 조회해서 동기화한다.
- 모든 서버 노드는 이벤트를 Redis 채널 하나에 발행하고, 자기 소켓으로 향하는 이벤트만 전달한다.
  접속 상태는 노드별 소켓 수를 Redis 해시에 두고, 노드가 죽으면 만료된다.
- 멘션은 메시지 본문에 `<@user-id>` / `<!channel>` 토큰으로 저장하고, 전송 시점에 `mentions` 테이블로
  펼친다. 입력창에는 `@이름`으로 보인다.
- 비공개 채널과 DM은 비멤버에게 없는 것과 똑같이 보인다(404). REST와 실시간 모두 같다.
- `apps/server/src/queries.ts`가 Channel·Message 응답 형태를 소유한다. 같은 변경에 대한 REST 응답과
  실시간 이벤트가 똑같다.
- `apps/server/src/notify.ts`가 누구에게 푸시를 보낼지 혼자 결정한다. 클라이언트는 이 판단을 반복하지 않는다.
- `messages.id`는 전역 단조 증가 커서로, 페이지 이동, 읽음 상태, 미읽음 수에 쓴다.
- `apps/web/src/cache.ts`가 클라이언트 캐시 변경을 모두 소유한다. 같은 변경의 REST 응답과
  실시간 이벤트가 같은 방식으로 중복 제거된다.
- 첨부 파일은 서버 로컬 디스크에 둔다(서버 1대 전제, 여러 대로 늘리면 S3로 교체).
  검색은 별도 엔진 없이 Postgres `pg_trgm`을 쓴다.

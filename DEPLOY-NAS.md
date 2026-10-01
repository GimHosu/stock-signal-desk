# 시놀로지 NAS(Docker) 배포 안내

DS220+ · Container Manager 기준입니다. 앱 주소는 `https://finance.hosu.me/` 입니다.

## 0. 준비물

- 이 폴더(`stock-signal-desk`) 전체
- 텔레그램 봇 토큰·채팅 ID, Finnhub 키 (지금 Vercel 환경변수에 넣은 값 그대로)
- (토스 연동) 토스증권 WTS에서 발급한 `client_id`, `client_secret`

## 1. NAS에 파일 올리기

1. **File Station** → `docker` 공유 폴더(없으면 만들기) 안에 `stock-signal-desk` 폴더를 만듭니다.
2. 이 PC의 `바탕화면\stock-signal-desk` 안 파일을 모두 그 폴더로 올립니다.
   (`.git`, `.claude` 폴더는 올리지 않아도 됩니다)
3. 같은 폴더에 **`data`** 폴더를 하나 만듭니다. (종목 목록·신호 기록이 여기 저장됩니다)

## 2. 설정 파일(.env) 만들기

1. 올린 파일 중 `.env.example` 을 복사해 이름을 **`.env`** 로 바꿉니다.
   (File Station 에서 점으로 시작하는 파일이 안 보이면: 설정 → '숨김 파일 표시')
2. `.env` 를 텍스트 편집기(DSM 의 Text Editor 패키지 또는 PC에서 편집 후 업로드)로 열어 값을 채웁니다.
   - `APP_PASSWORD` : 앱 비밀번호
   - `APP_URL=https://finance.hosu.me/` (`BASE_PATH` 는 비워 둡니다)
   - `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `FINNHUB_API_KEY` (지금 Vercel 에 넣은 값)
   - `TOSS_CLIENT_ID`, `TOSS_CLIENT_SECRET` (토스 연동 시)

`.env` 에는 비밀번호와 키가 들어 있으니 다른 곳에 공유하지 마세요.

## 3. 컨테이너 만들기

1. **Container Manager → 프로젝트 → 생성**
2. 프로젝트 이름: `stock-signal-desk`, 경로: `docker/stock-signal-desk` 선택
3. 원본: **"기존 docker-compose.yml 사용"** → 다음 → (웹 포털 설정은 건너뛰기) → 완료
4. 이미지 빌드(1~2분) 후 컨테이너가 실행됩니다. 상태가 **정상(healthy)** 이 되면 성공입니다.
5. 집 안에서 먼저 확인: `http://NAS내부IP:18080/` → 비밀번호 입력 창이 뜨면 성공

## 4. 외부 주소 연결 (finance.hosu.me)

1. **DNS 레코드 추가** — hosu.me 도메인을 관리하는 곳(도메인 구입처 또는 Cloudflare 등)에서
   `finance` 라는 이름으로 **CNAME → hosu.me** 레코드를 추가합니다. (hosu.me 와 같은 NAS 를 가리키게)
   몇 분~몇 시간 뒤 `finance.hosu.me` 가 NAS 로 연결됩니다.
2. **역방향 프록시 규칙** — 제어판 → 로그인 포털 → 고급 → **역방향 프록시** → 생성
   - 이름: `stock-signal-desk`
   - 소스: 프로토콜 **HTTPS** · 호스트 이름 **finance.hosu.me** · 포트 **443** (HSTS 사용 체크 권장)
   - 대상: 프로토콜 **HTTP** · 호스트 이름 **localhost** · 포트 **18080**
3. **HTTPS 인증서** — 제어판 → 보안 → 인증서
   - hosu.me 용 Let's Encrypt 인증서가 이미 있으면 **수정 → 주체 대체 이름**에 `finance.hosu.me` 를 추가해 갱신하거나,
     **추가 → 새 인증서 → Let's Encrypt** 로 `finance.hosu.me` 인증서를 새로 받습니다.
     (Let's Encrypt 발급에는 공유기에서 80 포트가 NAS 로 열려 있어야 합니다)
   - 같은 화면의 **설정** 버튼 → 서비스 목록에서 `finance.hosu.me` 에 방금 인증서를 지정합니다.
4. 휴대폰 데이터(LTE/5G)로 `https://finance.hosu.me` 에 접속해 비밀번호 입력 창이 뜨면 완료입니다.

공유기에서 443 포트가 NAS 로 열려 있어야 합니다 (hosu.me 를 이미 외부에서 쓰고 있다면 되어 있을 가능성이 큽니다).

## 5. 기존 데이터 옮기기

1. **지금 Vercel 앱**에서 설정 → **내보내기 (JSON)** → 파일 저장
2. **NAS 앱**에서 비밀번호 입력 → 설정 → **가져오기** → 그 파일 선택
3. NAS 앱에서 **종목 발굴 → 지금 스캔** 을 한 번 눌러 스캔 결과를 만듭니다.
4. 텔레그램 **테스트 알림 보내기** 로 알림이 오는지 확인합니다.

## 6. 토스증권 연동

1. NAS 앱 설정 창의 **토스증권 보유 종목 동기화 → 지금 동기화** 를 누릅니다.
2. 처음에는 "허용 IP ○○○를 등록해 주세요" 가 나옵니다 → 토스증권 WTS → 설정 → Open API → **허용 IP 관리** 에 그 IP 를 등록
3. 다시 **지금 동기화** → 미국 주식 보유 종목이 들어오면 완료
   - 이후 평일 한국 시간 06:45 에 자동 동기화 → 07:00 아침 알림 → 07:15 S&P 500 스캔 순서로 실행됩니다.
   - 집 인터넷 공인 IP 가 바뀌면 동기화가 실패하고 설정 창에 새 IP 가 표시됩니다. 토스에 새 IP 를 등록하세요.
   - 조회 API만 쓰고 주문 API는 호출하지 않습니다. 토스에서 모두 판 종목은 '보유 종목'에서 빠지고, 관심 종목은 그대로 둡니다.

## 7. 코드 수정 반영 (앞으로)

수정된 파일을 NAS 폴더에 덮어쓴 뒤 Container Manager → 프로젝트 → `stock-signal-desk` → **빌드** (또는 중지 → 빌드 → 시작).
`data` 폴더와 `.env` 는 그대로 유지됩니다.

## 8. Vercel · GitHub 정리 (NAS 가 며칠 문제없이 돌아간 뒤)

1. **Vercel**: 프로젝트 → Settings → 맨 아래 **Delete Project**
   (Storage 의 Upstash Redis 도 Storage 탭에서 삭제)
2. **GitHub**: 저장소 `GimHosu/stock-signal-desk` → Settings → 맨 아래 **Delete this repository**
3. PC 의 `stock-signal-desk` 폴더는 NAS 에 올릴 원본으로 계속 보관하면 됩니다.

## 문제 해결

| 증상 | 확인할 것 |
|---|---|
| 컨테이너가 계속 재시작 | Container Manager → 컨테이너 → 로그. `.env` 오타·누락 확인 |
| 화면이 하얗거나 깨짐 | `.env` 의 `BASE_PATH` 가 비어 있는지 확인 (서브도메인은 비워 둠) |
| 아침 알림이 안 옴 | 설정 창 '마지막 자동 점검' 기록 · 컨테이너 로그의 `[daily-alert]` 줄 |
| 접속이 안 됨 | DNS(CNAME) 반영 여부, 역방향 프록시 대상 포트(18080), 공유기 443 포트 |
| 토스 동기화 403 | 토스 허용 IP 에 설정 창에 표시된 공인 IP 등록 |

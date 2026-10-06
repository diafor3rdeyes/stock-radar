# 종목 레이더 클라우드플레어 배포

구성: 화면(index.html)은 Cloudflare Pages, 최신 집계 데이터는 Cloudflare KV, 데이터 수집은 GitHub Actions가 맡습니다.
시세가 10분마다 바뀌어도 사이트를 다시 배포하지 않도록 데이터를 KV에 따로 둡니다.

## 1. 깃허브 저장소 만들기
이 폴더 전체를 새 저장소에 올립니다. 공개 저장소면 Actions 사용 시간 제한이 없고, 비공개는 월 사용 시간이 정해져 있습니다.

## 2. KV 만들기
Cloudflare 대시보드 → 스토리지 및 데이터베이스 → KV → 네임스페이스 만들기 (이름 예: radar).
만든 뒤 네임스페이스 ID를 적어 둡니다.

## 3. Pages 프로젝트 만들기
Workers & Pages → 만들기 → Pages → 깃허브 저장소 연결.
빌드 명령은 비우고, 출력 디렉터리는 `/`로 둡니다.
배포 후 프로젝트 설정 → 함수 → KV 네임스페이스 바인딩에 변수 이름 `RADAR`, 값은 위에서 만든 네임스페이스를 넣고 다시 배포합니다.

## 4. API 토큰 만들기
My Profile → API 토큰 → 사용자 지정 토큰.
권한: 계정 → Workers KV 스토리지 → 편집.

## 5. 깃허브 시크릿 넣기 (저장소 설정 → Secrets and variables → Actions)
- CF_ACCOUNT_ID: 계정 ID
- CF_KV_NAMESPACE_ID: 2번의 네임스페이스 ID
- CF_API_TOKEN: 4번의 토큰
- DART_API_KEY: opendart.fss.or.kr에서 무료 발급
- SEC_USER_AGENT: `StockRadar 내이름 내이메일@example.com` 형식

## 6. 첫 실행
저장소 Actions 탭 → radar → Run workflow → mode에 `full`.
성공하면 `https://프로젝트이름.pages.dev/trend.json`이 열리고, 사이트 화면이 샘플에서 실제 값으로 바뀝니다.
이후 전체 갱신은 하루 3번, 시세 갱신은 평일 10분마다 자동으로 돕니다.

## 알아둘 점
- 이 설정은 한 번도 실행해 보지 못했습니다. 첫 실행에서 막히는 곳이 있으면 Actions 로그를 알려 주세요.
- 깃허브 서버 주소에서 디시인사이드가 접속을 막을 수 있습니다. 그러면 로그에 제외 사유가 찍히고, 그 갤러리만 건너뜁니다.
- 평소 기준(최근 7일 평균)은 전체 갱신이 며칠 쌓여야 생깁니다. 처음 며칠은 "기준 수집 중"으로 보입니다.
- 사이트는 누구나 열 수 있는 주소가 됩니다. 비공개로 쓰려면 Cloudflare Access로 로그인을 걸 수 있습니다.

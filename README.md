# Financial Bot

Discord 금융 리서치·스크리닝 봇입니다. 공개 저장소는 명령 처리, 리포트 큐, 결제 웹훅, 차트 및 보고서 렌더링을 담당하고, `financial-bot-internal`은 리서치·시장 데이터·뉴스 수집·저장소·벤치마크 시뮬레이션을 제공합니다.

## 기능

- `/report`: 활성 스킬로 리포트를 요청하고 HTML·PNG 산출물을 전달합니다.
- `/stock`, `/etf`, `/stockscreen`, `/etfscreen`: 로컬 시장 데이터 조회·스크리닝입니다.
- `/benchmark`: 모의 포트폴리오·거래 기록을 조회합니다.
- `/plan`: 개인·서버 이용권을 관리합니다.
- `/skills`: 관리자가 활성화한 스킬을 확인합니다.
- 선택 기능: Gumroad 결제 연동, 유휴 시간 기반 자동 리포트, 데이터·뉴스 수집기입니다.

## 설치와 실행

Node.js 22.22 이상과 Bun 1.3.4를 사용합니다.

```bash
bun install
cd renderer
bun install
cd ..
cp .env.example .env
bun run provider:status
bun run start
```

Discord를 실행할 때만 `DISCORD_BOT_TOKEN`과 `DISCORD_APPLICATION_ID`가 필요합니다. 워커·수집기·결제 전용 프로세스는 Discord 로그인을 하지 않습니다.

리서치 워커에는 내부 패키지와 그 실행 환경이 필요합니다. `CODEX_PROFILE`, `CODEX_GUARD_PROFILE`, `CODEX_BENCHMARK_PROFILE`은 로컬 실행 프로필을 지정합니다. 리포트 PNG 캡처 스크립트는 기본적으로 `~/.codex/skills/context-report-studio/scripts/capture_report_pages.mjs`를 사용하며, `REPORT_CAPTURE_SCRIPT_PATH`로 변경할 수 있습니다.

## 내부 엔진 선택

- `INTERNAL_PROVIDER_MODE=auto`: 설치된 패키지 → 인접 저장소 순서로 시도하며, 둘 다 없으면 공개 모드로 동작합니다.
- `INTERNAL_PROVIDER_MODE=package`: 내부 엔진을 불러오지 못하면 시작 시 오류를 반환합니다.
- `INTERNAL_PROVIDER_MODE=disabled`: 내부 엔진 없이 `/skills`를 제공합니다.
- `INTERNAL_PROVIDER_PACKAGE`를 지정하면 해당 경로만 사용합니다. 지정한 경로에 문제가 있어도 다른 엔진으로 전환하지 않습니다. 공개 `package.json`의 내부 의존성은 Git revision으로 고정되므로, 내부 엔진 변경을 배포하려면 내부 새 revision을 먼저 발행하고 공개 저장소의 pin을 갱신해야 합니다.

인접 내부 저장소를 개발 중이면 다음과 같이 명시합니다.

```dotenv
INTERNAL_PROVIDER_MODE=package
INTERNAL_PROVIDER_PACKAGE=../financial-bot-internal/src/index.js
```

`bun run start:env -- --env <이름>`은 내부 런처를 사용합니다. 실제 실행할 환경 파일에도 의도한 `INTERNAL_PROVIDER_PACKAGE`를 설정하십시오.

## 실행 역할

| BOT_RUNTIME_ROLE | 역할 |
| --- | --- |
| standalone | 공개 Discord·리포트 큐·결제 경계와 설정된 내부 worker/collector |
| ingress | 공개 Discord 명령 접수·응답·진행 상황 전달 |
| worker | 내부 리서치와 시뮬레이션, 공개 렌더링 경로 호출 |
| collector | 내부 시장·뉴스·ETF 데이터 수집 |
| payment | 공개 결제 웹훅 |

`BOT_CAPABILITIES`로 역할의 기능 목록을 직접 지정할 수도 있습니다. 실행 상태는 `bun run runtime:status`로 확인합니다.

## 리포트 흐름

모든 신규 요청은 같은 파일 큐를 거칩니다.

1. Ingress가 이용 가능 여부와 기존 요청·캐시를 확인하고 작업을 등록합니다.
2. 워커가 질문을 검사합니다. 거절된 질문은 리서치와 이용권 차감으로 진행하지 않습니다.
3. 정책 조사와 시장 스크리닝·후보 조사를 병렬로 실행한 뒤 최종 판단을 만듭니다.
4. 보고서 계획 JSON을 고정 HTML 템플릿에 적용하고 PNG를 캡처합니다. `ai-trading`이 활성화되어 있으면 모의투자 판단도 처리합니다.
5. 워커가 진행 상황과 결과를 저장합니다. Ingress가 산출물 동기화를 확인한 뒤 Discord로 전달합니다.
6. 전달 성공 여부와 이용권 승인 결과를 저장해 일반적인 전송 실패 시 재시도합니다.

리포트 캐시는 질문·스킬·거래일·세션·모드별로 최대 1시간 재사용합니다. 같은 사용자 또는 채널의 미전달 요청이 있으면 새 요청을 받지 않습니다.

`REPORT_JOB_CONCURRENCY`의 기본값은 3, `REPORT_JOB_TIMEOUT_MS`는 1시간입니다. 작업 파일은 임시 파일 작성 후 이름 변경으로 게시합니다. 종료된 로컬 워커의 잠금은 즉시 복구하며, 임시 실행 파일은 작업으로 취급하지 않습니다. 결과가 이미 존재하는 작업은 다시 실행하지 않습니다.

큐와 작업 상태는 `runs/report-jobs/` 아래에 있습니다.

| 경로 | 내용 |
| --- | --- |
| pending, processing, processed | 대기·실행·완료 작업 및 결과 |
| requests | Ingress 요청 기록 |
| progress | 최신 진행 상황 |
| delivery | 전달 완료 및 이용권 승인 기록 |
| scratch | 자식 프로세스 임시 입출력·오류 로그 |
| failed | 형식이 잘못되어 격리된 작업 |

## 서버와 워커 분리

동일 호스트에서는 같은 런타임 디렉터리를 사용합니다. 다른 호스트에서는 [Ingress → Worker 예제](ops/rsync-ingress-to-worker.example.sh)와 [Worker → Ingress 예제](ops/rsync-worker-to-ingress.example.sh)를 환경에 맞게 설정하고 주기적으로 실행합니다.

- 작업 전송 시 워커의 파일을 삭제하지 않습니다.
- 산출물을 결과 메타데이터보다 먼저 동기화합니다.
- 워커 잠금, 임시 파일, Ingress의 전달 완료 기록은 호스트 사이에 복사하지 않습니다.
- SQLite는 실행 중인 DB 파일만 복사하지 않고 backup API로 스냅샷을 만듭니다.
- Ingress의 시장·벤치마크 복제본은 조회용입니다.

네트워크 장애 직후 Discord 응답 확인이나 이용권 승인 기록 저장 전에 프로세스가 종료되는 경우까지 완전한 exactly-once 처리를 보장하지는 않습니다. 기존 진행 메시지를 수정하는 방식과 저장된 승인·전달 기록으로 정상적인 재시도의 중복을 줄입니다.

## 데이터 기능과 렌더링

공개 저장소는 Discord 명령 접수와 응답, 리포트 큐, 결제 웹훅, 차트와 보고서 렌더링을 담당합니다. 리서치, 시장·뉴스 데이터 수집과 저장, 벤치마크 시뮬레이션은 비공개 [financial-bot-internal](../financial-bot-internal/README.md) 패키지가 담당합니다. 공개 런타임은 `INTERNAL_PROVIDER_MODE`와 `INTERNAL_PROVIDER_PACKAGE` 설정으로 내부 엔진에 연결합니다.

`/etf`와 관련 공개 명령은 요청을 처리하고 결과를 표시합니다. ETF 목록·공식 holdings·발행좌수/NAV·기준지수 수집, 이력 저장, 유입·유출 계산의 구현과 운영 CLI는 내부 저장소에 둡니다. 수집기는 `ETF_DIRECT_DATA_DIR`로 지정한 런타임 데이터 디렉터리를 사용합니다. 기존 운영 구성을 유지할 때 이 값은 공개 저장소의 `data/`를 가리킵니다. 수집 구현이 일부 공식 원천과 상품에 연결되어 있어도 전 세계 ETF 목록이나 전수 holdings·자본 시계열이 완성된 것은 아닙니다. 내부 문서의 `global_complete=false`와 source별 coverage를 완료 기준으로 확인하십시오. 공개 CLI는 조회·상태 확인만 지원하며 수집 명령과 원천 설정은 내부 저장소에서 관리합니다.

```bash
npm run etf:direct:query -- --share-class-id US:IVV:ETF --holdings-limit 5
npm run etf:direct:status
```

`renderer/`와 차트·보고서 캡처 경로는 공개 저장소에 있습니다. 예를 들어 다음 명령은 Yahoo 가격 데이터를 사용해 로컬 PineTS 지표를 렌더링합니다.

```bash
cd renderer
bun run render -- --source yahoo --symbol AAPL --timeframe D --preset rsi --out-dir outputs/aapl
```

## 결제 설정

`GUMROAD_PING_ENABLED=true`일 때 `GUMROAD_PING_SECRET`이 필수입니다. 같은 값을 콜백 URL의 `secret`, 지원하는 비밀값 헤더 또는 요청 본문에 설정합니다. 비밀값 없이 서버를 시작하거나 콜백을 등록할 수 없습니다.

기본 요청 본문 한도는 1 MiB이며 `GUMROAD_PING_MAX_BODY_BYTES`로 조정합니다. 잘못된 JSON과 과도한 본문은 DB 처리 전에 거절하고, 로그의 비밀값·토큰·라이선스 키는 가립니다.

## 검증

```bash
npm run check
npm test
npm --prefix renderer test
```

CI에서도 공개 저장소 검증을 실행합니다. 테스트는 임시 디렉터리와 모의 공급자를 사용하며 실제 Discord 전송·결제 변경·유료 리서치를 실행하지 않습니다. ETF·시장·뉴스 도메인 테스트는 내부 저장소 루트에서 `npm test`로 실행합니다.

활성 스킬은 [config/skills.json](config/skills.json)에서 관리합니다. 변경 후 Discord 명령 선택지를 갱신하려면 봇을 재시작합니다. 운영 문서는 [이용약관](docs/terms-clause-ko.md), [개인정보 처리방침](docs/privacy-policy-ko.md), [리포트 작성 지침](docs/report-compliance-guidelines.md)을 참고하십시오.

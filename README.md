# AI Team Messenger

개인용 멀티 AI 협업 메신저. Vite + TypeScript 프런트엔드, Cloudflare Workers API, D1 저장소, GitHub Pages 배포 구성입니다.

**새 설치의 실제 API는 기본적으로 전부 차단됩니다.** 새 설치에 `FREE_POLICY` Secret이 없으면 API 키만 추가해도 실행되지 않습니다. 무료 계정·모델·차단 정책을 확인한 운영자만 해당 제공업체를 활성화하세요. 앱 호출량은 제공업체 잔여 할당량과 다릅니다. 앱은 계정의 결제 설정을 자동으로 검증할 수 없으므로 유료 계정에 연결하면 무과금을 보장할 수 없습니다.

## 구현 기능

- 채팅방 생성·이름 변경·삭제, 방별 설정 및 AI 역할
- AI 등록·편집·삭제·초대·퇴장·활성화, 같은 모델로 독립 멤버 생성
- 모델 검색·무료 필터·직접 ID 입력, 미검증 모델 실행 차단
- ID 기반 멘션 선택, `@이름` / `@모두`, 자동 응답 끄기
- 병렬 답변, 순차 토론 + 최종 요약, 제한된 자율 대화 + 요약
- 실행 중단, 실패 멤버만 수동 재시도, 새로고침 후 기록 및 계속 진행
- 동시 실행 방지, 원자적 사용량 예약, 요청/토큰 한도, 429 대기
- 명시적으로 허용한 무료 대체 모델만 일반 API 오류에 한 번 호출
- Markdown/코드, DOMPurify 정화, CSP, 다크/라이트, 모바일 메뉴
- Gemini/Groq/OpenRouter/Z.AI/Mistral/Workers AI 어댑터
- 추가 Cohere/NVIDIA/Hugging Face 어댑터 (계정별 검증 후 사용)

## 로컬에서 실행

Node.js 22.20+ 필요. 프로젝트 디렉터리에서:

```sh
npm ci
cp .dev.vars.example .dev.vars
openssl rand -hex 32
```

생성한 토큰을 `.dev.vars`의 `ACCESS_TOKEN` 값으로 넣으세요. `.dev.vars`는 Git에 포함되지 않습니다.

```sh
npm run db:local
npm run dev:api
```

다른 터미널에서:

```sh
npm run dev
```

`http://127.0.0.1:5173`에서 **워크스페이스 연결하기**를 눌러 `http://127.0.0.1:8787`과 접근 토큰을 입력합니다. 포트나 호스트를 변경하면 `ALLOWED_ORIGIN`도 정확히 일치시켜야 합니다.

### 비용 없는 테스트 모드

실제 API 키 없이 확인하려면 `.dev.vars`에 `MOCK_ENABLED=true`를 추가하고 API 서버를 재시작하세요. 새 AI에서 **테스트 AI (가상 응답)** → 모델 조회 → `test-model`을 선택합니다. 모든 응답에 `[테스트용 가상 응답]`이 표시됩니다. 테스트 모드에서는 외부 생성 API를 호출하지 않습니다. 배포 시 `MOCK_ENABLED=false`를 유지하세요.

## 실제 제공업체 활성화

[제공업체 가이드](docs/PROVIDERS.md)를 먼저 확인합니다. 비밀 키는 Workers Secrets에만 저장하며 브라우저에 넣지 않습니다.

```sh
npx wrangler secret put ACCESS_TOKEN
npx wrangler secret put OPENROUTER_API_KEY
```

`FREE_POLICY`는 `npx wrangler secret put FREE_POLICY`로 저장하는 계정별 JSON 정책입니다. `config/free-policy.example.json`은 구조 예시이며 **비활성·만료 상태**입니다. 계정의 무료 전용 여부와 자동 과금 차단, 선택한 모델의 공식 가격을 직접 확인한 후 `accountFreeOnly`, `noPaidOverflow`를 true로 바꾸고 `verifiedUntil`을 짧은 유효기간으로 설정합니다. 가급적 7일 이내로 재검증합니다. 계정이 유료 전환되면 정책을 즉시 지우세요.

- `models`: 정확한 모델 ID의 허용 목록. OpenRouter만 `*:free` 와일드카드를 지원합니다.
- `source`: 검증한 공식 문서 URL. URL 존재만으로 무료가 증명되는 것은 아닙니다.
- `dayLimit`, `monthLimit`: 이 앱의 요청 상한. 다른 앱에서도 같은 키를 쓰면 공유 한도를 더 낮게 잡으세요.
- `tokenDayLimit`: 입력 UTF-8 바이트 수 + 최대 출력 토큰 + 여유분으로 예약하는 보수적 토큰 예산. 실제 사용 토큰도 별도로 기록합니다.
- `verifiedUntil`: UTC ISO 시각. 만료 즉시 새 호출을 차단합니다.

무료 요금제로 자동 전환하거나 유료 모델로 우회하는 기능은 없습니다. 외부 API HTTP 오류의 본문은 키·민감정보 노출 방지를 위해 사용자에게 그대로 반환하지 않습니다.

## 배포

[배포 체크리스트](docs/DEPLOYMENT.md)에 GitHub Pages, Cloudflare Workers, D1 생성부터 연결까지 순서를 정리했습니다. GitHub Actions는 `npm ci`, 테스트, 빌드 후 `dist/`만 Pages에 올립니다. Worker와 Secrets는 이 워크플로에 포함되지 않습니다.

```sh
npm test
npm run build
```

## 구성

```text
src/main.ts             메신저 UI와 실행 단계 진행
src/style.css           반응형 디자인
worker/index.ts         인증, 입력 검증, CORS, REST API
worker/providers.ts     제공업체 공통 어댑터와 무료 검증
worker/engine.ts        실행 계획, 대화 맥락, 중단, 사용량 예약
worker/types.ts         모델 및 비실행 FutureTool 인터페이스
migrations/0001_initial.sql   데이터와 원자적 한도 트리거
config/                 정책 설정 예시
.github/workflows/      Pages 배포
```

## 실행·저장 방식과 제한

브라우저가 `/runs/:id/step`을 요청할 때 서버가 D1에서 단계 하나를 원자적으로 점유합니다. 병렬 모드에서는 방의 동시 요청 설정만큼 요청하고 각 응답이 완료되는 대로 화면을 갱신합니다. 토론·자율 모드는 직전 단계 완료 후 다음 단계를 실행합니다. 요약도 예산에 포함되는 별도 API 요청입니다. 준비 단계에서 기본 모델과 허용한 대체 모델의 예상 요청 수를 확인하며, 각 실제 요청 전 원자적 DB 트리거가 한도를 다시 검사합니다.

탭을 닫으면 새 단계는 시작하지 않습니다. 새로고침 후 **계속 진행**으로 재개합니다. 120초 이상 결과를 알 수 없는 단계는 실패로 기록하며 자동 재전송하지 않습니다. 중단 직전에 공급자에 전송된 요청은 이미 할당량을 소비할 수 있습니다. 늦게 도착한 응답은 대화에 추가하지 않습니다. 사용자 수동 재시도는 새 호출이며 성공한 멤버는 제외됩니다. 토론 실패 재시도는 실패한 멤버별 단일 답변으로 진행하며 전체 라운드를 다시 돌리지 않습니다.

한 화면에는 최신 500개 메시지, 최신 30개 실행을 표시합니다. 서버에는 이전 기록도 유지됩니다. AI 맥락에는 최근 40개 메시지 중 길이를 제한한 대화를 사용하므로 매우 긴 대화의 과거 내용이 제외될 수 있습니다. AI 등록 수의 고정 상한은 없습니다. 실행당 최대 60단계, 동시에 최대 6개 HTTP 요청, 사용자 설정으로 최대 50명의 AI를 선택할 수 있습니다. 실시간 토큰 스트리밍 대신 응답 단위 갱신을 사용합니다.

사용량은 UTC 일/월 기준입니다. 삭제한 방의 사용량은 호출 제한 우회를 방지하기 위해 남겨 둡니다. 채팅 메시지·멤버십·실행 단계는 방 삭제 시 연쇄 삭제합니다. 멤버를 삭제해도 기존 작성자 이름 및 실제 제공업체/모델 기록은 보존합니다. 다른 계정/앱의 사용량, Workers AI Neuron 잔여량, HF 크레딧 잔여량을 자동으로 읽지 않습니다. 무료 계정의 공급자 측 초과 차단이 필수입니다.

## 검증 범위

`tests/app.test.ts`는 실제 로컬 workerd + D1에서 인증, CORS, CRUD, 동시 점유, ID 멘션, 토론, 요약, 자율 모드, 취소, 한도 경쟁, 미연결 차단, 429, 삭제 보존을 검증합니다. UI는 DOM 기반 테스트로 로그인 이후 화면, Markdown XSS 정화, 설정 및 메시지 저장 동작을 검사합니다. 네트워크 어댑터의 응답 형식은 가상 HTTP 응답으로 검사합니다.

GitHub Pages 공개 배포, 원격 D1 마이그레이션 및 Workers 배포를 완료했습니다. 실제 AI 연결 검증 결과는 아래 현재 배포 항목을 참고하세요. 모바일 브라우저 시각 검증은 아직 수행하지 않았습니다. 테스트 성공이 실제 AI 연결을 증명하지는 않습니다.

## 추후 확장

- 오래된 메시지 페이지 조회와 JSON 내보내기
- 토큰 스트리밍, 제공업체 계정별 한도 API 연동
- 모델별 RPM/TPM 세부 정책, 실행 내 실패 단계별 정밀 재시도
- Durable Objects를 이용한 서버측 실행 조정
- 승인 기반 도구 인터페이스 확장 (현재 실제 도구 실행은 없음)

저장소: https://github.com/jhlee2027/ai-team-messenger · 기본 브랜치: `main`. 마지막 커밋은 `git log -1 --oneline`으로 확인합니다.

## 현재 배포

- 사이트: https://jhlee2027.github.io/ai-team-messenger/
- API: https://ai-team-messenger.ai-team-messenger.workers.dev
- 서버 접근 토큰은 Workers Secret으로 관리하며 Git에 포함하지 않습니다.
- 새 설치에서는 접근 토큰을 설정해야 하고, 실제 AI는 무료 정책을 확인한 후 활성화합니다.

### 실제 AI 연결 검증 (2026-11-01)

사용자가 Workers Free 플랜임을 확인한 뒤 Llama 3.2 3B 기획자와 Llama 3.1 8B FP8 검토자를 연결했습니다. 실제 병렬 응답 2회, 토론·요약 3회, 자율 대화·요약 3회가 완료되었고 실제 토큰 수를 D1에 저장했습니다. 무료 테스트 모드는 사용하지 않았습니다. 다른 제공업체의 연결은 아직 검증하지 않았습니다.

현재 계정 정책: 하루 20회, 월 300회, 일일 보수적 토큰 예약 200,000. 검증 만료는 2026-11-08 09:00 KST이며 그 이후에는 새 호출을 차단합니다. 이 정책은 공개 저장소가 아닌 Workers Secret에만 저장되며, 로컬 정책 파일은 Git에서 제외합니다. 계정이 Paid로 변경되면 정책을 즉시 비활성화해야 합니다.

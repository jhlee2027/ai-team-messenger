# 제공업체 연결 및 무료 정책

확인일: 2026-10-31. 모델명은 추천 후보일 뿐 활성화 근거가 아닙니다. 이 프로젝트는 모델 ID를 UI나 엔진에 고정하지 않습니다. 가격 API가 없는 제공업체는 운영자가 검증한 `FREE_POLICY.models` 레지스트리를 사용합니다. 현재 실제 사용자 API 키가 없어 모든 외부 연결 성공 여부는 미검증입니다.

| 제공업체 | 목록 및 호출 구현 | 활성화 전 조건 |
|---|---|---|
| Gemini | `models` 목록, `generateContent` 전용 어댑터 | Google AI Studio에서 해당 프로젝트의 Free Tier 및 모델 무료 할당량 확인. Cloud Billing 연결 금지 |
| Groq | `/openai/v1/models`, OpenAI 호환 생성 | Free Plan, 계정 콘솔 모델별 요청/토큰 한도 확인 |
| OpenRouter | `/api/v1/models`, OpenAI 호환 생성 | `:free` 또는 `openrouter/free`이면서 모든 가격 필드가 0인지 매 호출 전 확인. 유료 자동 대체 비활성 |
| Z.AI | 운영자 모델 레지스트리, OpenAI 호환 생성 | 현재 확인한 공식 가격표에서 GLM-4.5/4.7 Flash 무료를 확인하지 못함. 무료 근거 확보 전 활성화 금지 |
| Mistral | `/v1/models`, OpenAI 호환 생성 | 공식 도움말에 Free mode가 설명되어 있으나 실제 계정·모델별 가용성 확인 필수 |
| Workers AI | AI binding, 선택적 공식 모델 목록 REST API | Workers Free 계정만. 유료 계정의 10,000 Neurons 초과분은 과금되므로 연결 금지. 모델별 Free 이용 가능 여부 확인 |
| Cohere | `/v1/models?endpoint=chat`, `/v2/chat` | Evaluation 키 전용, 월간 평가 호출 제한과 개발 용도 준수 |
| NVIDIA NIM | `/v1/models`, `/v1/chat/completions` | 개발용 계정에서 해당 모델의 무료 이용 권한과 초과 차단을 확인해야 함. 기본 차단 |
| Hugging Face | Router `/v1/models`, OpenAI 호환 생성 | 무료 크레딧 외 추가 과금 불가능한 계정만. 앱은 크레딧 잔여량을 계산하지 않으므로 초과 차단을 검증할 수 없다면 활성화하지 않음 |

Workers AI 모델 카탈로그 조회를 원하면 `CF_ACCOUNT_ID`, 읽기 권한이 있는 `CF_API_TOKEN`을 Secrets로 추가합니다. 키 없이 AI binding만 사용하면 검증된 모델 레지스트리를 사용합니다. 목록에 나타난다는 사실은 무료를 뜻하지 않습니다. 카탈로그가 일부만 반환되면 해당 모델은 실행을 차단합니다.

OpenRouter를 제외한 제공업체의 가격과 계정 요금제는 서버가 실시간 자동 검증하지 못합니다. 운영자의 짧은 유효기간 정책과 공급자의 무료 전용 계정 하드 차단을 함께 사용합니다. 이 조건이 불명확한 제공업체는 등록만 가능하며 실행은 계속 차단해야 합니다.

공식 근거:

- [Gemini 결제 및 Free Tier](https://ai.google.dev/gemini-api/docs/billing), [모델 가격](https://ai.google.dev/gemini-api/docs/pricing)
- [Groq 한도](https://console.groq.com/docs/rate-limits)
- [OpenRouter 무료 모델](https://openrouter.ai/collections/free-models), [모델 목록 API](https://openrouter.ai/docs/api/api-reference/models/get-models)
- [Z.AI 가격](https://docs.z.ai/guides/overview/pricing)
- [Mistral 요금제별 제한](https://help.mistral.ai/en/articles/698531-why-am-i-hitting-api-rate-limits-and-how-do-i-increase-them)
- [Workers AI 가격](https://developers.cloudflare.com/workers-ai/platform/pricing/), [모델 API](https://developers.cloudflare.com/api/resources/ai/)
- [Cohere 평가 키 및 한도](https://docs.cohere.com/docs/rate-limits), [모델 목록](https://docs.cohere.com/reference/list-models)
- [NVIDIA NIM API](https://docs.api.nvidia.com/nim/reference/llm-apis)
- [Hugging Face 크레딧 및 결제](https://huggingface.co/docs/inference-providers/pricing)

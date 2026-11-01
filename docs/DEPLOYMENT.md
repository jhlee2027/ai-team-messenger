# 외부 서비스 설정 체크리스트

아래는 새 계정에 설치하는 절차입니다. 현재 원본 프로젝트는 이미 GitHub Pages·Workers·D1에 배포되어 있으므로 데이터베이스를 다시 만들 필요가 없습니다. 유료 플랜 전환은 하지 않았으며 AI API 키도 등록하지 않았습니다.

## Cloudflare

- [ ] Workers **Free** 요금제 확인. Workers Paid 또는 유료 AI 자동 충전을 켜지 않습니다.
- [ ] 프로젝트 터미널에서 `npx wrangler login` 실행 후 브라우저에서 로그인.
- [ ] `npx wrangler d1 create ai-team-messenger` 실행.
- [ ] 출력된 database_id를 `wrangler.toml`에 입력.
- [ ] `npm run db:remote` 실행해 스키마 적용.
- [ ] `openssl rand -hex 32`로 개인 접근 토큰 생성 후 `npx wrangler secret put ACCESS_TOKEN`으로 저장. 토큰은 채팅이나 GitHub에 올리지 않습니다.
- [ ] 선택한 AI 키를 `npx wrangler secret put OPENROUTER_API_KEY` 등으로 저장.
- [ ] 무료 계정과 모델 가격 확인 후 `npx wrangler secret put FREE_POLICY`로 JSON 정책 저장. 처음에는 제공업체 1개·낮은 호출량으로 시작.
- [ ] `ALLOWED_ORIGIN = "https://사용자명.github.io"` 설정. URL 경로 및 마지막 `/`를 넣지 않습니다.
- [ ] `MOCK_ENABLED = "false"` 유지.
- [ ] Workers AI를 사용할 때만 `wrangler.toml`의 `[ai] binding = "AI"` 주석 해제.
- [ ] `npm run deploy:api` 실행하고 반환된 Workers URL 기록.

## GitHub Pages

- [ ] GitHub에서 `ai-team-messenger` 저장소 생성. 공개 저장소는 Pages 무료 호스팅 경로로 사용 가능하며 개인 토큰과 API 키를 절대 커밋하지 않습니다.
- [ ] 이 프로젝트만 저장소에 업로드. `node_modules`, `.dev.vars`, `.wrangler`는 제외됩니다.
- [ ] 기본 브랜치를 `main`으로 사용하거나 `.github/workflows/pages.yml`의 브랜치 수정.
- [ ] Settings → Pages → Source를 **GitHub Actions**로 선택.
- [ ] `main`에 push한 뒤 Pages workflow 성공 확인.
- [ ] Pages 주소를 열고 Workers URL과 개인 접근 토큰 입력.
- [ ] 새 채팅방 → AI 등록 → 모델 조회 → 초대 → 연결 테스트(1회 호출).
- [ ] 2명으로 동시 답변, 1라운드 토론, 2회 자율 응답, 중지, 새로고침 복구 확인.
- [ ] 공급자 콘솔에서 무료 요청으로 기록되었는지 확인. 무료 여부가 불명확하면 즉시 `FREE_POLICY`에서 제거.

## 운영 주의점

- 브라우저가 공개여도 API는 모든 요청에 토큰을 확인합니다. CORS는 추가 제한입니다.
- 인증 실패 요청은 DB에 기록하지 않습니다. 공개 엔드포인트 자체의 악의적 대량 트래픽을 처리하려면 Cloudflare 보안 규칙을 추가로 검토하세요.
- 토큰 유출 시 Workers Secret을 교체하고 각 탭에서 재연결합니다.
- D1/Workers/AI 각각의 Free 사용량은 Cloudflare 대시보드에서 확인합니다.
- 동일 GitHub origin 안의 다른 앱도 신뢰 가능한 코드인지 확인합니다. 전용 origin 사용이 더 단순합니다.
- `.dev.vars`와 production Secrets는 별개입니다. 로컬 테스트 키를 운영에 복사할 필요는 없습니다.

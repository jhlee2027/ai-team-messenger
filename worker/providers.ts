import { AppError, assert, type Env, type Policy } from "./types";
export const catalog = [
  {
    id: "gemini",
    name: "Google Gemini",
    key: "GEMINI_API_KEY",
    base: "https://generativelanguage.googleapis.com/v1beta",
    docs: "https://ai.google.dev/gemini-api/docs/pricing",
  },
  {
    id: "groq",
    name: "Groq",
    key: "GROQ_API_KEY",
    base: "https://api.groq.com/openai/v1",
    docs: "https://console.groq.com/docs/rate-limits",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    key: "OPENROUTER_API_KEY",
    base: "https://openrouter.ai/api/v1",
    docs: "https://openrouter.ai/collections/free-models",
  },
  {
    id: "zai",
    name: "Z.AI",
    key: "ZAI_API_KEY",
    base: "https://api.z.ai/api/paas/v4",
    docs: "https://docs.z.ai/guides/overview/pricing",
  },
  {
    id: "mistral",
    name: "Mistral AI",
    key: "MISTRAL_API_KEY",
    base: "https://api.mistral.ai/v1",
    docs: "https://help.mistral.ai/en/articles/698531-why-am-i-hitting-api-rate-limits-and-how-do-i-increase-them",
  },
  {
    id: "cloudflare",
    name: "Workers AI",
    key: "AI",
    base: "https://api.cloudflare.com/client/v4",
    docs: "https://developers.cloudflare.com/workers-ai/platform/pricing/",
  },
  {
    id: "cohere",
    name: "Cohere · 평가용",
    key: "COHERE_API_KEY",
    base: "https://api.cohere.com",
    docs: "https://docs.cohere.com/docs/rate-limits",
  },
  {
    id: "nvidia",
    name: "NVIDIA NIM · 개발용",
    key: "NVIDIA_API_KEY",
    base: "https://integrate.api.nvidia.com/v1",
    docs: "https://docs.api.nvidia.com/nim/reference/llm-apis",
  },
  {
    id: "huggingface",
    name: "Hugging Face · 크레딧",
    key: "HF_API_KEY",
    base: "https://router.huggingface.co/v1",
    docs: "https://huggingface.co/docs/inference-providers/pricing",
  },
  {
    id: "mock",
    name: "테스트 AI (가상 응답)",
    key: "MOCK_ENABLED",
    base: "",
    docs: "",
  },
];
export type Model = {
  id: string;
  name: string;
  free: boolean;
  available: boolean;
  capabilities: string[];
  reason: string;
};
export function getPolicy(env: Env, id: string): Policy | undefined {
  if (id === "mock" && env.MOCK_ENABLED === "true")
    return {
      accountFreeOnly: true,
      noPaidOverflow: true,
      verifiedUntil: "2099-01-01",
      source: "local test",
      models: ["test-model"],
      dayLimit: 100,
      monthLimit: 1000,
      tokenDayLimit: 1000000,
    };
  let p: Policy;
  try {
    p = JSON.parse(env.FREE_POLICY || "{}")[id];
  } catch {
    return undefined;
  }
  if (
    !p ||
    !p.accountFreeOnly ||
    !p.noPaidOverflow ||
    !p.source ||
    !Array.isArray(p.models) ||
    !(Date.parse(p.verifiedUntil) > Date.now())
  )
    return undefined;
  if (
    ![p.dayLimit, p.monthLimit, p.tokenDayLimit].every(
      (n) => Number.isInteger(n) && n > 0,
    )
  )
    return undefined;
  return p;
}
export function configured(env: Env, id: string) {
  const c = catalog.find((c) => c.id === id);
  return (
    !!c && (id === "mock" ? env.MOCK_ENABLED === "true" : !!(env as any)[c.key])
  );
}
export function zeroPrice(m: any): boolean {
  return (
    (m.id?.endsWith(":free") || m.id === "openrouter/free") &&
    m.pricing &&
    ["prompt", "completion"].every(
      (k) => m.pricing[k] !== undefined && Number(m.pricing[k]) === 0,
    ) &&
    Object.values(m.pricing).every((v) => Number(v) === 0)
  );
}
export class ProviderAdapter {
  readonly meta: (typeof catalog)[number] | undefined;
  constructor(
    readonly env: Env,
    readonly providerId: string,
  ) {
    this.meta = catalog.find((c) => c.id === providerId);
    assert(this.meta, "알 수 없는 제공업체");
  }
  get providerName() {
    return this.meta!.name;
  }
  headers() {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${(this.env as any)[this.meta!.key] ?? ""}`,
    };
  }
  async request(path: string, body?: unknown): Promise<any> {
    const headers: any = this.headers();
    if (this.providerId === "gemini") {
      delete headers.Authorization;
      headers["x-goog-api-key"] = this.env.GEMINI_API_KEY;
    }
    let response: Response;
    try {
      response = await fetch(this.meta!.base + path, {
        method: body ? "POST" : "GET",
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(45000),
      });
    } catch {
      throw new AppError(
        502,
        "제공업체 응답을 확인하지 못했습니다. 자동 재시도하지 않습니다.",
      );
    }
    if (!response.ok) {
      if (response.status === 429)
        await this.handleRateLimit(response.headers.get("retry-after"));
      throw new AppError(
        response.status === 429 ? 429 : 502,
        `${this.providerName} HTTP ${response.status} · 키, 모델, 할당량을 확인하세요.`,
      );
    }
    return response.json();
  }
  async handleRateLimit(retry: string | null) {
    let seconds = Number(retry);
    if (!Number.isFinite(seconds) || seconds <= 0) seconds = 60;
    seconds = Math.min(seconds, 86400);
    await this.env.DB.prepare(
      "INSERT INTO providers(id,cooldown_until,status) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET cooldown_until=excluded.cooldown_until,status=excluded.status",
    )
      .bind(this.providerId, Date.now() + seconds * 1000, "429")
      .run();
  }
  async getUsageInfo() {
    const p = getPolicy(this.env, this.providerId);
    const row = await this.env.DB.prepare(
      "SELECT cooldown_until FROM providers WHERE id=?",
    )
      .bind(this.providerId)
      .first();
    return {
      appLimits: p
        ? { day: p.dayLimit, month: p.monthLimit, tokensDay: p.tokenDayLimit }
        : null,
      providerRemaining: null,
      cooldownUntil: row?.cooldown_until ?? 0,
      note: "앱 기록은 공급자의 실제 잔여량이 아닙니다.",
    };
  }
  async listModels(): Promise<Model[]> {
    const p = getPolicy(this.env, this.providerId);
    let raw: any[] = [];
    if (this.providerId === "mock")
      raw = [{ id: "test-model", name: "가상 응답 · 테스트 전용" }];
    else if (!configured(this.env, this.providerId))
      raw = (p?.models ?? []).map((id) => ({ id }));
    else if (this.providerId === "gemini") {
      const r = await this.request("/models?pageSize=1000");
      raw = (r.models ?? [])
        .filter((m: any) =>
          m.supportedGenerationMethods?.includes("generateContent"),
        )
        .map((m: any) => ({
          ...m,
          id: m.name.replace("models/", ""),
          name: m.displayName,
        }));
    } else if (this.providerId === "cohere")
      raw = (
        (await this.request("/v1/models?endpoint=chat&page_size=1000"))
          .models ?? []
      ).map((m: any) => ({ ...m, id: m.name }));
    else if (
      this.providerId === "cloudflare" &&
      this.env.CF_ACCOUNT_ID &&
      this.env.CF_API_TOKEN
    ) {
      const response = await fetch(
        `${this.meta!.base}/accounts/${encodeURIComponent(this.env.CF_ACCOUNT_ID)}/ai/models/search`,
        {
          headers: { Authorization: `Bearer ${this.env.CF_API_TOKEN}` },
          signal: AbortSignal.timeout(15000),
        },
      );
      assert(response.ok, "Workers AI 모델 목록 조회 실패", 502);
      const result: any = await response.json();
      raw = (result.result ?? [])
        .filter((m: any) => m.task?.name === "Text Generation")
        .map((m: any) => ({ ...m, id: m.name }));
    } else if (["zai", "cloudflare"].includes(this.providerId))
      raw = (p?.models ?? []).map((id) => ({ id }));
    else raw = (await this.request("/models")).data ?? [];
    return raw.map((m) => {
      const approved =
        !!p &&
        (p.models.includes(m.id) ||
          (this.providerId === "openrouter" && p.models.includes("*:free")));
      const free =
        approved && (this.providerId !== "openrouter" || zeroPrice(m));
      return {
        id: m.id,
        name: m.name ?? m.id,
        free,
        available: free && configured(this.env, this.providerId),
        capabilities: ["text"],
        reason: free ? "무료 정책 확인됨" : "무료 계정·모델 검증 필요",
      };
    });
  }
  async validateModel(model: string) {
    assert(
      configured(this.env, this.providerId),
      "API 키 또는 바인딩 설정 필요",
      409,
    );
    const p = getPolicy(this.env, this.providerId);
    assert(p, "무료 계정 정책 미설정 또는 만료: 호출 차단", 403);
    const m = (await this.listModels()).find((m) => m.id === model);
    assert(
      m?.free && m.available,
      "무료 여부 또는 모델 가용성을 확인할 수 없습니다.",
      403,
    );
    return m;
  }
  async generateResponse(
    model: string,
    system: string,
    context: { role: string; content: string }[],
    maxTokens: number,
  ) {
    const cooldown = await this.env.DB.prepare(
      "SELECT cooldown_until FROM providers WHERE id=?",
    )
      .bind(this.providerId)
      .first<number>("cooldown_until");
    assert(!cooldown || cooldown < Date.now(), "요청 제한 대기 중입니다.", 429);
    if (this.providerId === "mock")
      return {
        text: `**[테스트용 가상 응답]**\n\n${system.slice(0, 130)}\n\n공유 맥락에서 읽은 작성자: ${[...new Set((context.at(-1)?.content ?? "").match(/\[[^\]\n]+\]/g) ?? [])].join(", ")}\n\n최근 공유 맥락: ${context.at(-1)?.content.slice(-160) ?? ""}\n\n이 메시지는 실제 AI가 생성하지 않았습니다.`,
        input: 0,
        output: 0,
      };
    let r: any;
    if (this.providerId === "gemini") {
      r = await this.request(
        `/models/${encodeURIComponent(model)}:generateContent`,
        {
          systemInstruction: { parts: [{ text: system }] },
          contents: context.map((m) => ({
            role: m.role === "assistant" ? "model" : "user",
            parts: [{ text: m.content }],
          })),
          generationConfig: { maxOutputTokens: maxTokens },
        },
      );
      return {
        text:
          r.candidates?.[0]?.content?.parts
            ?.map((p: any) => p.text ?? "")
            .join("") ?? "",
        input: r.usageMetadata?.promptTokenCount,
        output: r.usageMetadata?.candidatesTokenCount,
      };
    }
    if (this.providerId === "cloudflare") {
      r = await this.env.AI!.run(model, {
        messages: [{ role: "system", content: system }, ...context],
        max_tokens: maxTokens,
      });
      return {
        text: r.response ?? "",
        input: r.usage?.prompt_tokens,
        output: r.usage?.completion_tokens,
      };
    }
    if (this.providerId === "cohere") {
      r = await this.request("/v2/chat", {
        model,
        messages: [{ role: "system", content: system }, ...context],
        max_tokens: maxTokens,
      });
      return {
        text: r.message?.content?.map((c: any) => c.text ?? "").join("") ?? "",
        input: r.usage?.tokens?.input_tokens,
        output: r.usage?.tokens?.output_tokens,
      };
    }
    r = await this.request("/chat/completions", {
      model,
      messages: [{ role: "system", content: system }, ...context],
      max_tokens: maxTokens,
      stream: false,
      ...(this.providerId === "openrouter"
        ? { provider: { allow_fallbacks: false } }
        : {}),
    });
    return {
      text: r.choices?.[0]?.message?.content ?? "",
      input: r.usage?.prompt_tokens,
      output: r.usage?.completion_tokens,
    };
  }
}

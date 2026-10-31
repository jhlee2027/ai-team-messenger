export interface Env {
  DB: D1Database;
  AI?: { run(model: string, input: unknown): Promise<any> };
  ACCESS_TOKEN?: string;
  ALLOWED_ORIGIN: string;
  FREE_POLICY: string;
  DAILY_LIMIT: string;
  MONTHLY_LIMIT: string;
  REQUESTS_PER_MINUTE: string;
  MOCK_ENABLED?: string;
  GEMINI_API_KEY?: string;
  GROQ_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  ZAI_API_KEY?: string;
  MISTRAL_API_KEY?: string;
  COHERE_API_KEY?: string;
  NVIDIA_API_KEY?: string;
  HF_API_KEY?: string;
  CF_ACCOUNT_ID?: string;
  CF_API_TOKEN?: string;
}
export interface Policy {
  accountFreeOnly: boolean;
  noPaidOverflow: boolean;
  verifiedUntil: string;
  source: string;
  models: string[];
  dayLimit: number;
  monthLimit: number;
  tokenDayLimit: number;
}
export interface Agent {
  id: string;
  name: string;
  provider: string;
  model: string;
  role: string;
  prompt: string;
  avatar: string;
  active: boolean;
  maxTokens: number;
  fallback?: { provider: string; model: string };
  allowFallback: boolean;
}
export interface Settings {
  mode: "parallel" | "discussion" | "autonomous";
  rounds: number;
  maxResponses: number;
  maxAgents: number;
  concurrency: number;
  dailyLimit: number;
  autoReply: boolean;
}
export const defaults: Settings = {
  mode: "parallel",
  rounds: 2,
  maxResponses: 6,
  maxAgents: 4,
  concurrency: 3,
  dailyLimit: 50,
  autoReply: true,
};
export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function assert(ok: unknown, message: string, status = 400): asserts ok {
  if (!ok) throw new AppError(status, message);
}
export function str(x: unknown, max = 10000): string {
  assert(
    typeof x === "string" && x.trim().length > 0 && x.length <= max,
    "입력 길이 또는 형식이 올바르지 않습니다.",
  );
  return x.trim();
}
export function integer(x: unknown, min: number, max: number): number {
  assert(
    Number.isInteger(x) && Number(x) >= min && Number(x) <= max,
    `${min}~${max} 범위의 정수가 필요합니다.`,
  );
  return Number(x);
}
export function settings(x: any): Settings {
  return {
    mode: ["parallel", "discussion", "autonomous"].includes(x.mode)
      ? x.mode
      : "parallel",
    rounds: integer(x.rounds ?? 2, 1, 10),
    maxResponses: integer(x.maxResponses ?? 6, 1, 50),
    maxAgents: integer(x.maxAgents ?? 4, 1, 50),
    concurrency: integer(x.concurrency ?? 3, 1, 6),
    dailyLimit: integer(x.dailyLimit ?? 50, 1, 1000),
    autoReply: x.autoReply !== false,
  };
}
export interface FutureTool {
  name: string;
  describe(): string;
  requiresApproval: true;
}
// Deliberately no execute method or executable tools in this MVP.

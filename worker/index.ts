import {
  AppError,
  assert,
  str,
  integer,
  settings,
  defaults,
  type Env,
  type Agent,
} from "./types";
import { catalog, configured, getPolicy, ProviderAdapter } from "./providers";
import { createRun, cancelRun, stepRun, recover } from "./engine";
const uuid = () => crypto.randomUUID();
const json = (data: unknown, status = 200) => Response.json(data, { status });
async function auth(req: Request, env: Env) {
  assert(
    env.ACCESS_TOKEN && env.ACCESS_TOKEN.length >= 32,
    "서버 접근 토큰이 설정되지 않았습니다.",
    503,
  );
  const actual = req.headers.get("Authorization") ?? "";
  const expected = "Bearer " + env.ACCESS_TOKEN;
  const hash = async (s: string) =>
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
    );
  const [a, b] = await Promise.all([hash(actual), hash(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  assert(diff === 0, "접근 토큰을 확인하세요.", 401);
  const window = String(Math.floor(Date.now() / 60000));
  const row = await env.DB.prepare(
    "INSERT INTO rate_windows(id,count) VALUES(?,1) ON CONFLICT(id) DO UPDATE SET count=count+1 RETURNING count",
  )
    .bind(window)
    .first<number>("count");
  assert(
    Number(row) <= Number(env.REQUESTS_PER_MINUTE || 90),
    "잠시 후 다시 시도하세요.",
    429,
  );
  await env.DB.prepare("DELETE FROM rate_windows WHERE id < ?")
    .bind(String(Number(window) - 2))
    .run();
}
async function body(req: Request) {
  assert(
    Number(req.headers.get("Content-Length") || 0) <= 40000,
    "요청이 너무 큽니다.",
    413,
  );
  const reader = req.body?.getReader();
  assert(reader, "요청 본문이 필요합니다.");
  let size = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 40000) {
      await reader.cancel();
      throw new AppError(413, "요청이 너무 큽니다.");
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(all));
  } catch {
    throw new AppError(400, "JSON 형식이 올바르지 않습니다.");
  }
}
function agentData(b: any, id: string): Agent {
  assert(
    catalog.some((c) => c.id === b.provider),
    "알 수 없는 제공업체",
  );
  if (b.fallback) {
    assert(
      catalog.some((c) => c.id === b.fallback.provider),
      "대체 제공업체 오류",
    );
    str(b.fallback.model, 200);
  }
  return {
    id,
    name: str(b.name, 40),
    provider: b.provider,
    model: str(b.model, 200),
    role: str(b.role, 300),
    prompt: typeof b.prompt === "string" ? b.prompt.slice(0, 2000) : "",
    avatar: typeof b.avatar === "string" ? b.avatar.slice(0, 4) : "✦",
    active: b.active !== false,
    maxTokens: integer(b.maxTokens ?? 600, 64, 2048),
    allowFallback: b.allowFallback === true,
    fallback: b.fallback
      ? { provider: b.fallback.provider, model: b.fallback.model }
      : undefined,
  };
}
async function route(req: Request, env: Env) {
  const url = new URL(req.url),
    path = url.pathname,
    method = req.method;
  await auth(req, env);
  if (path === "/api/bootstrap" && method === "GET")
    return json({
      rooms: (
        await env.DB.prepare(
          "SELECT * FROM rooms ORDER BY created_at,rowid",
        ).all()
      ).results.map((r: any) => ({ ...r, settings: JSON.parse(r.settings) })),
      agents: (
        await env.DB.prepare("SELECT data FROM agents").all()
      ).results.map((r: any) => JSON.parse(r.data)),
      providers: catalog
        .filter((c) => c.id !== "mock" || env.MOCK_ENABLED === "true")
        .map((c) => ({
          id: c.id,
          name: c.name,
          docs: c.docs,
          configured: configured(env, c.id),
          verified: !!getPolicy(env, c.id),
        })),
    });
  if (path === "/api/rooms" && method === "POST") {
    const b = await body(req),
      id = uuid();
    await env.DB.prepare("INSERT INTO rooms(id,name,settings) VALUES(?,?,?)")
      .bind(id, str(b.name, 80), JSON.stringify(defaults))
      .run();
    return json({ id }, 201);
  }
  let match = path.match(/^\/api\/rooms\/([^/]+)$/);
  if (match) {
    const id = match[1];
    assert(
      await env.DB.prepare("SELECT id FROM rooms WHERE id=?").bind(id).first(),
      "채팅방 없음",
      404,
    );
    if (method === "GET") {
      await recover(env, id);
      const [room, members, messages, runs, tasks] = await Promise.all([
        env.DB.prepare("SELECT * FROM rooms WHERE id=?").bind(id).first<any>(),
        env.DB.prepare(
          "SELECT a.data,ra.role,ra.active FROM agents a JOIN room_agents ra ON a.id=ra.agent_id WHERE ra.room_id=?",
        )
          .bind(id)
          .all<any>(),
        env.DB.prepare(
          "SELECT * FROM (SELECT rowid AS seq,* FROM messages WHERE room_id=? ORDER BY rowid DESC LIMIT 500) ORDER BY seq",
        )
          .bind(id)
          .all(),
        env.DB.prepare(
          "SELECT * FROM conversation_runs WHERE room_id=? ORDER BY rowid DESC LIMIT 30",
        )
          .bind(id)
          .all(),
        env.DB.prepare(
          "SELECT t.* FROM run_tasks t WHERE run_id IN (SELECT id FROM conversation_runs WHERE room_id=? ORDER BY rowid DESC LIMIT 30) ORDER BY ordinal",
        )
          .bind(id)
          .all<any>(),
      ]);
      return json({
        room: { ...room, settings: JSON.parse(room.settings) },
        members: members.results.map((r) => ({
          ...JSON.parse(r.data),
          role: r.role,
          active: !!r.active && JSON.parse(r.data).active,
        })),
        messages: messages.results,
        runs: runs.results,
        tasks: tasks.results.map((t) => ({ ...t, agent: JSON.parse(t.agent) })),
      });
    }
    if (method === "PATCH") {
      const b = await body(req);
      if (b.name)
        await env.DB.prepare("UPDATE rooms SET name=? WHERE id=?")
          .bind(str(b.name, 80), id)
          .run();
      if (b.settings)
        await env.DB.prepare("UPDATE rooms SET settings=? WHERE id=?")
          .bind(JSON.stringify(settings(b.settings)), id)
          .run();
      return json({ ok: true });
    }
    if (method === "DELETE") {
      await env.DB.prepare("DELETE FROM rooms WHERE id=?").bind(id).run();
      return json({ ok: true });
    }
  }
  if (path === "/api/agents" && method === "POST") {
    const a = agentData(await body(req), uuid());
    await env.DB.prepare("INSERT INTO agents(id,data) VALUES(?,?)")
      .bind(a.id, JSON.stringify(a))
      .run();
    return json(a, 201);
  }
  match = path.match(/^\/api\/agents\/([^/]+)$/);
  if (match) {
    if (method === "PUT") {
      const a = agentData(await body(req), match[1]);
      await env.DB.prepare("UPDATE agents SET data=? WHERE id=?")
        .bind(JSON.stringify(a), a.id)
        .run();
      return json(a);
    }
    if (method === "DELETE") {
      await env.DB.prepare("DELETE FROM agents WHERE id=?")
        .bind(match[1])
        .run();
      return json({ ok: true });
    }
  }
  match = path.match(/^\/api\/rooms\/([^/]+)\/members\/([^/]+)$/);
  if (match) {
    const [, room, agent] = match;
    if (method === "PUT") {
      const b = await body(req);
      await env.DB.prepare(
        "INSERT INTO room_agents(room_id,agent_id,role,active) VALUES(?,?,?,?) ON CONFLICT(room_id,agent_id) DO UPDATE SET role=excluded.role,active=excluded.active",
      )
        .bind(room, agent, str(b.role, 300), Number(b.active !== false))
        .run();
      return json({ ok: true });
    }
    if (method === "DELETE") {
      await env.DB.prepare(
        "DELETE FROM room_agents WHERE room_id=? AND agent_id=?",
      )
        .bind(room, agent)
        .run();
      return json({ ok: true });
    }
  }
  match = path.match(/^\/api\/providers\/([^/]+)\/models$/);
  if (match && method === "GET") {
    const adapter = new ProviderAdapter(env, match[1]);
    const models = await adapter.listModels();
    if (models.length)
      await env.DB.batch(
        models.map((m) =>
          env.DB.prepare(
            "INSERT INTO models(provider,id,data) VALUES(?,?,?) ON CONFLICT(provider,id) DO UPDATE SET data=excluded.data,checked_at=CURRENT_TIMESTAMP",
          ).bind(match![1], m.id, JSON.stringify(m)),
        ),
      );
    return json({ models, usage: await adapter.getUsageInfo() });
  }
  match = path.match(/^\/api\/rooms\/([^/]+)\/messages$/);
  if (match && method === "POST") {
    const b = await body(req);
    await env.DB.prepare(
      "INSERT INTO messages(id,room_id,author,kind,content) VALUES(?,?,'나','user',?)",
    )
      .bind(uuid(), match[1], str(b.content))
      .run();
    return json({ ok: true });
  }
  match = path.match(/^\/api\/rooms\/([^/]+)\/runs$/);
  if (match && method === "POST") {
    const b = await body(req),
      room = await env.DB.prepare("SELECT settings FROM rooms WHERE id=?")
        .bind(match[1])
        .first<string>("settings");
    assert(room, "채팅방 없음", 404);
    const s = settings(JSON.parse(room));
    const mode = b.mode ?? s.mode;
    assert(
      ["parallel", "discussion", "autonomous"].includes(mode),
      "대화 모드 오류",
    );
    let agents = (
      await env.DB.prepare(
        "SELECT a.data,ra.role,ra.active FROM agents a JOIN room_agents ra ON a.id=ra.agent_id WHERE ra.room_id=?",
      )
        .bind(match[1])
        .all<any>()
    ).results
      .filter((r) => r.active)
      .map((r) => ({ ...JSON.parse(r.data), role: r.role }))
      .filter((a) => a.active);
    if (b.agentIds) {
      assert(Array.isArray(b.agentIds), "멘션 형식 오류");
      agents = agents.filter((a) => b.agentIds.includes(a.id));
    }
    if (b.retryRunId) {
      const failed = (
        await env.DB.prepare(
          "SELECT agent FROM run_tasks WHERE run_id=? AND status='failed' AND run_id IN(SELECT id FROM conversation_runs WHERE room_id=? AND status='failed')",
        )
          .bind(str(b.retryRunId, 100), match[1])
          .all<any>()
      ).results.map((r) => JSON.parse(r.agent).id);
      agents = agents.filter((a) => failed.includes(a.id));
      assert(agents.length, "재시도할 실패 응답이 없습니다.");
    }
    return json(
      await createRun(
        env,
        match[1],
        b.retryRunId ? "parallel" : mode,
        str(b.goal),
        agents,
        s,
        b.retryRunId,
      ),
      201,
    );
  }
  match = path.match(/^\/api\/runs\/([^/]+)\/(step|cancel)$/);
  if (match && method === "POST") {
    if (match[2] === "cancel") {
      await cancelRun(env, match[1]);
      return json({ ok: true });
    }
    return json(await stepRun(env, match[1]));
  }
  if (path === "/api/usage" && method === "GET") {
    return json({
      daily: (
        await env.DB.prepare(
          "SELECT provider,model,count(*) requests,sum(input_tokens) input_tokens,sum(output_tokens) output_tokens,sum(estimate) reserved_tokens,sum(state='error') errors FROM usage_records WHERE created_at>=date('now') GROUP BY provider,model",
        ).all()
      ).results,
      monthly: (
        await env.DB.prepare(
          "SELECT provider,count(*) requests FROM usage_records WHERE created_at>=date('now','start of month') GROUP BY provider",
        ).all()
      ).results,
      limits: {
        day: Number(env.DAILY_LIMIT || 100),
        month: Number(env.MONTHLY_LIMIT || 1000),
      },
      note: "UTC 기준 · 앱에서 예약/전송한 요청 기록. 공급자의 실제 잔여량은 알 수 없습니다. 삭제한 채팅방의 사용량도 한도에 포함됩니다.",
    });
  }
  throw new AppError(404, "API 경로를 찾을 수 없습니다.");
}
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const origin = req.headers.get("Origin");
    const allowed = env.ALLOWED_ORIGIN;
    let response: Response;
    if (origin && origin !== allowed)
      return json({ error: "허용되지 않은 출처" }, 403);
    if (req.method === "OPTIONS") {
      response = new Response(null, { status: 204 });
    } else {
      try {
        response = await route(req, env);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "";
        const status =
          e instanceof AppError
            ? e.status
            : msg.includes("_LIMIT")
              ? 429
              : msg.includes("FOREIGN KEY")
                ? 404
                : 500;
        response = json(
          {
            error:
              e instanceof AppError
                ? e.message
                : status === 429
                  ? "사용량 제한에 도달했습니다."
                  : status === 404
                    ? "대상을 찾을 수 없습니다."
                    : "서버 요청을 처리하지 못했습니다.",
          },
          status,
        );
      }
    }
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store");
    headers.set("X-Content-Type-Options", "nosniff");
    if (origin === allowed) {
      headers.set("Access-Control-Allow-Origin", allowed);
      headers.set("Vary", "Origin");
      headers.set(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type",
      );
      headers.set(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      );
    }
    return new Response(response.body, { status: response.status, headers });
  },
};

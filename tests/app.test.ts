import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { makePlan, createRun, stepRun } from "../worker/engine";
import { zeroPrice, getPolicy, ProviderAdapter } from "../worker/providers";
import { defaults, type Agent, type Env } from "../worker/types";
let mf: Miniflare, db: D1Database;
const token = "t".repeat(64);
let room: string;
let agents: Agent[] = [];
async function request(
  path: string,
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const r = await mf.dispatchFetch("http://local/api" + path, {
    method,
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return {
    status: r.status,
    data: (await r.json()) as any,
    headers: r.headers,
  };
}
async function run(mode: string, ids = agents.map((a) => a.id)) {
  const r = await request(`/rooms/${room}/runs`, "POST", {
    mode,
    goal: "작은 앱의 구조를 설계해줘",
    agentIds: ids,
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.id;
}
async function drain(id: string) {
  for (let i = 0; i < 20; i++) {
    await Promise.all([
      request(`/runs/${id}/step`, "POST", {}),
      request(`/runs/${id}/step`, "POST", {}),
    ]);
    const state = await db
      .prepare("SELECT status FROM conversation_runs WHERE id=?")
      .bind(id)
      .first<string>("status");
    if (!["pending", "running"].includes(state!)) return state;
  }
  throw Error("run did not finish");
}
before(async () => {
  const bundle = await build({
    entryPoints: ["worker/index.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
  });
  mf = new Miniflare({
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-08-01",
    d1Databases: ["DB"],
    bindings: {
      ACCESS_TOKEN: token,
      ALLOWED_ORIGIN: "http://127.0.0.1:5173",
      MOCK_ENABLED: "true",
      FREE_POLICY: "{}",
      DAILY_LIMIT: "100",
      MONTHLY_LIMIT: "1000",
      REQUESTS_PER_MINUTE: "10000",
    },
  });
  db = (await mf.getD1Database("DB")) as unknown as D1Database;
  const sql = await readFile("migrations/0001_initial.sql", "utf8");
  // D1 exec uses single-line statements; trigger bodies must remain intact.
  const beforeTrigger = sql
    .slice(0, sql.indexOf("CREATE TRIGGER"))
    .replace(/--[^\n]*/g, "");
  for (const stmt of beforeTrigger.split(";").filter((s) => s.trim()))
    await db.prepare(stmt).run();
  await db.prepare(sql.slice(sql.indexOf("CREATE TRIGGER"))).run();
});
after(async () => {
  await mf?.dispose();
});
test("authentication, fail-closed token and exact-origin CORS", async () => {
  assert.equal(
    (
      await request("/bootstrap", "GET", undefined, {
        Authorization: "Bearer wrong",
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await request("/bootstrap", "GET", undefined, {
        Origin: "https://evil.example",
      })
    ).status,
    403,
  );
  const r = await request("/bootstrap", "GET", undefined, {
    Origin: "http://127.0.0.1:5173",
  });
  assert.equal(r.status, 200);
  assert.equal(
    r.headers.get("Access-Control-Allow-Origin"),
    "http://127.0.0.1:5173",
  );
  assert.equal(r.headers.get("Cache-Control"), "no-store");
  const empty = new Miniflare({
    modules: true,
    script: (
      await build({
        entryPoints: ["worker/index.ts"],
        bundle: true,
        write: false,
        format: "esm",
      })
    ).outputFiles[0].text,
    compatibilityDate: "2026-08-01",
    bindings: { ALLOWED_ORIGIN: "x" },
  });
  try {
    assert.equal(
      (await empty.dispatchFetch("http://x/api/bootstrap")).status,
      503,
    );
  } finally {
    await empty.dispose();
  }
});
test("unverified, expired and nonzero-price models are blocked", () => {
  assert.equal(getPolicy({ FREE_POLICY: "{}" } as Env, "gemini"), undefined);
  assert.equal(
    getPolicy(
      {
        FREE_POLICY: JSON.stringify({
          groq: {
            accountFreeOnly: true,
            noPaidOverflow: true,
            source: "official",
            models: ["x"],
            verifiedUntil: "2020-01-01",
            dayLimit: 1,
            monthLimit: 1,
            tokenDayLimit: 1,
          },
        }),
      } as Env,
      "groq",
    ),
    undefined,
  );
  assert.ok(
    zeroPrice({ id: "x:free", pricing: { prompt: "0", completion: "0" } }),
  );
  assert.ok(
    !zeroPrice({
      id: "x:free",
      pricing: { prompt: "0", completion: "0", request: ".01" },
    }),
  );
  assert.ok(
    !zeroPrice({ id: "paid", pricing: { prompt: "0", completion: "0" } }),
  );
  assert.ok(!zeroPrice({ id: "x:free", pricing: { prompt: "0" } }));
});
test("room CRUD, independent agents and membership", async () => {
  const r = await request("/rooms", "POST", { name: "제품 설계" });
  assert.equal(r.status, 201);
  room = r.data.id;
  for (const name of ["기획자", "검토자"]) {
    const r = await request("/agents", "POST", {
      name,
      provider: "mock",
      model: "test-model",
      role: name,
      prompt: "근거를 제시하세요.",
      avatar: "✦",
      maxTokens: 100,
    });
    assert.equal(r.status, 201);
    agents.push(r.data);
    assert.equal(
      (
        await request(`/rooms/${room}/members/${r.data.id}`, "PUT", {
          role: name,
        })
      ).status,
      200,
    );
  }
  assert.notEqual(agents[0].id, agents[1].id);
  assert.equal((await request("/rooms/" + room)).data.members.length, 2);
  assert.equal(
    (
      await request("/rooms/" + room, "PATCH", {
        settings: { ...defaults, rounds: -1 },
      })
    ).status,
    400,
  );
});
test("parallel calls complete exactly once across racing step requests", async () => {
  const id = await run("parallel");
  assert.equal(
    (
      await request(`/rooms/${room}/runs`, "POST", {
        goal: "duplicate",
        mode: "parallel",
      })
    ).status,
    409,
  );
  assert.equal(await drain(id), "completed");
  const messages = await db
    .prepare("SELECT * FROM messages WHERE run_id=? AND kind='assistant'")
    .bind(id)
    .all();
  assert.equal(messages.results.length, 2);
  await request(`/runs/${id}/step`, "POST", {});
  assert.equal(
    await db
      .prepare("SELECT count(*) n FROM usage_records WHERE run_id=?")
      .bind(id)
      .first("n"),
    2,
  );
});
test("mentions use stable agent IDs after rename", async () => {
  agents[0].name = "새 기획자";
  await request("/agents/" + agents[0].id, "PUT", agents[0]);
  const id = await run("parallel", [agents[0].id]);
  await drain(id);
  assert.equal(
    await db
      .prepare("SELECT count(*) n FROM run_tasks WHERE run_id=?")
      .bind(id)
      .first("n"),
    1,
  );
  assert.equal(
    await db
      .prepare(
        "SELECT author FROM messages WHERE run_id=? AND kind='assistant'",
      )
      .bind(id)
      .first("author"),
    "새 기획자",
  );
});
test("discussion shares earlier messages and includes budgeted summary", async () => {
  const id = await run("discussion");
  assert.equal(await drain(id), "completed");
  assert.equal(
    await db
      .prepare("SELECT count(*) n FROM run_tasks WHERE run_id=?")
      .bind(id)
      .first("n"),
    5,
  );
  const msgs = (
    await db
      .prepare(
        "SELECT content FROM messages WHERE run_id=? AND kind='assistant' ORDER BY rowid",
      )
      .bind(id)
      .all<any>()
  ).results;
  assert.ok(msgs.at(-1).content.includes("최종 요약"));
  assert.ok(msgs[1].content.includes("[새 기획자]"));
});
test("bounded autonomous mode and cancellation prevent future API calls", async () => {
  await request("/rooms/" + room, "PATCH", {
    settings: { ...defaults, maxResponses: 3 },
  });
  const id = await run("autonomous");
  assert.equal(await drain(id), "completed");
  assert.equal(
    await db
      .prepare("SELECT count(*) n FROM run_tasks WHERE run_id=?")
      .bind(id)
      .first("n"),
    4,
  );
  const cancelled = await run("autonomous");
  await request(`/runs/${cancelled}/cancel`, "POST", {});
  await request(`/runs/${cancelled}/step`, "POST", {});
  assert.equal(
    await db
      .prepare("SELECT count(*) n FROM usage_records WHERE run_id=?")
      .bind(cancelled)
      .first("n"),
    0,
  );
  assert.equal(
    await db
      .prepare("SELECT status FROM conversation_runs WHERE id=?")
      .bind(cancelled)
      .first("status"),
    "cancelled",
  );
});
test("atomic quota reservation under concurrent requests", async () => {
  const limits = JSON.stringify({
    globalDay: 1000,
    globalMonth: 1000,
    providerDay: 1,
    providerMonth: 1,
    roomDay: 1000,
    tokenDay: 10000,
  });
  const inserts = await Promise.allSettled(
    [1, 2].map((i) =>
      db
        .prepare(
          "INSERT INTO usage_records(id,room_id,provider,model,estimate,limits) VALUES(?,?,?,?,?,?)",
        )
        .bind("race" + i, room, "quota-test", "model", 1, limits)
        .run(),
    ),
  );
  assert.equal(inserts.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(inserts.filter((x) => x.status === "rejected").length, 1);
});
test("preflight includes summary and fallback calls", () => {
  const a = {
    ...agents[0],
    allowFallback: true,
    fallback: { provider: "groq", model: "other" },
  };
  assert.equal(
    makePlan([a], { ...defaults, rounds: 2 }, "discussion").length,
    3,
  );
  assert.throws(() =>
    makePlan(agents, { ...defaults, maxAgents: 1 }, "parallel"),
  );
});
test("missing API key prevents a run without saving user messages", async () => {
  const r = await request("/agents", "POST", {
    name: "미연결",
    role: "검토",
    provider: "gemini",
    model: "unknown",
  });
  await request(`/rooms/${room}/members/${r.data.id}`, "PUT", { role: "검토" });
  const res = await request(`/rooms/${room}/runs`, "POST", {
    goal: "never charged",
    agentIds: [r.data.id],
  });
  assert.equal(res.status, 409);
  assert.equal(
    await db
      .prepare("SELECT count(*) n FROM messages WHERE content='never charged'")
      .first("n"),
    0,
  );
});
test("missing-key members are isolated while configured members answer", async () => {
  const r = await request(`/rooms/${room}/runs`, "POST", {
    goal: "all active members",
    mode: "parallel",
  });
  assert.equal(r.status, 201);
  assert.equal(await drain(r.data.id), "failed");
  assert.equal(
    await db
      .prepare(
        "SELECT count(*) n FROM run_tasks WHERE run_id=? AND status='completed'",
      )
      .bind(r.data.id)
      .first("n"),
    2,
  );
  assert.equal(
    await db
      .prepare(
        "SELECT count(*) n FROM run_tasks WHERE run_id=? AND status='failed'",
      )
      .bind(r.data.id)
      .first("n"),
    1,
  );
});
test("provider HTTP 429 records cooldown without automatic retry", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response("{}", {
      status: 429,
      headers: { "retry-after": "120" },
    });
  }) as typeof fetch;
  try {
    const adapter = new ProviderAdapter(
      { DB: db, GROQ_API_KEY: "test" } as Env,
      "groq",
    );
    await assert.rejects(
      () =>
        adapter.generateResponse(
          "m",
          "s",
          [{ role: "user", content: "x" }],
          64,
        ),
      /HTTP 429/,
    );
    assert.equal(calls, 1);
    await assert.rejects(
      () => adapter.generateResponse("m", "s", [], 64),
      /대기/,
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test("fallback is opt-in, attempted once and records actual provider", async () => {
  const policy = {
    accountFreeOnly: true,
    noPaidOverflow: true,
    source: "test-fixture",
    verifiedUntil: "2099-01-01",
    models: ["fixture"],
    dayLimit: 100,
    monthLimit: 1000,
    tokenDayLimit: 1000000,
  };
  const env = {
    DB: db,
    GROQ_API_KEY: "fixture",
    MISTRAL_API_KEY: "fixture",
    FREE_POLICY: JSON.stringify({ groq: policy, mistral: policy }),
    DAILY_LIMIT: "100",
    MONTHLY_LIMIT: "1000",
  } as Env;
  await db.prepare("DELETE FROM providers WHERE id='groq'").run();
  const a = {
    ...agents[0],
    provider: "groq",
    model: "fixture",
    allowFallback: true,
    fallback: { provider: "mistral", model: "fixture" },
  };
  const original = globalThis.fetch;
  let generated = 0;
  globalThis.fetch = (async (url: string, init: any) => {
    if (url.endsWith("/models"))
      return Response.json({ data: [{ id: "fixture" }] });
    generated++;
    assert.equal(JSON.parse(init.body).stream, false);
    return url.includes("groq")
      ? new Response("{}", { status: 500 })
      : Response.json({
          choices: [{ message: { content: "fallback success" } }],
          usage: { prompt_tokens: 5, completion_tokens: 3 },
        });
  }) as typeof fetch;
  try {
    const r = await createRun(
      env,
      room,
      "parallel",
      "fallback test",
      [a],
      defaults,
    );
    await stepRun(env, r.id);
    assert.equal(generated, 2);
    const m = await db
      .prepare("SELECT * FROM messages WHERE run_id=? AND kind='assistant'")
      .bind(r.id)
      .first<any>();
    assert.equal(m.provider, "mistral");
    assert.equal(m.model, "fixture");
    assert.ok(m.content.includes("대체 모델"));
    assert.equal(
      await db
        .prepare("SELECT count(*) n FROM usage_records WHERE run_id=?")
        .bind(r.id)
        .first("n"),
      2,
    );
    generated = 0;
    const blocked = await createRun(
      env,
      room,
      "parallel",
      "no fallback",
      [{ ...a, allowFallback: false }],
      defaults,
    );
    await stepRun(env, blocked.id);
    assert.equal(generated, 1);
    assert.equal(
      await db
        .prepare("SELECT status FROM conversation_runs WHERE id=?")
        .bind(blocked.id)
        .first("status"),
      "failed",
    );
  } finally {
    globalThis.fetch = original;
  }
});
test("one failed member does not stop others; retry only calls failed member", async () => {
  const id = await run("parallel");
  const task = await db
    .prepare(
      "SELECT id,agent FROM run_tasks WHERE run_id=? ORDER BY ordinal LIMIT 1",
    )
    .bind(id)
    .first<any>();
  const a = JSON.parse(task.agent);
  await db
    .prepare("UPDATE run_tasks SET agent=? WHERE id=?")
    .bind(JSON.stringify({ ...a, model: "unverified" }), task.id)
    .run();
  assert.equal(await drain(id), "failed");
  assert.equal(
    await db
      .prepare(
        "SELECT count(*) n FROM run_tasks WHERE run_id=? AND status='completed'",
      )
      .bind(id)
      .first("n"),
    1,
  );
  const r = await request(`/rooms/${room}/runs`, "POST", {
    goal: "retry failed",
    retryRunId: id,
  });
  assert.equal(r.status, 201);
  assert.equal(await drain(r.data.id), "completed");
  assert.equal(
    await db
      .prepare("SELECT count(*) n FROM run_tasks WHERE run_id=?")
      .bind(r.data.id)
      .first("n"),
    1,
  );
  assert.equal(
    await db
      .prepare(
        "SELECT json_extract(agent,'$.id') id FROM run_tasks WHERE run_id=?",
      )
      .bind(r.data.id)
      .first("id"),
    a.id,
  );
});
test("stale in-flight tasks fail without automatic duplicate requests", async () => {
  const id = await run("parallel", [agents[0].id]);
  await db
    .prepare(
      "UPDATE run_tasks SET status='running',started_at=datetime('now','-3 minutes') WHERE run_id=?",
    )
    .bind(id)
    .run();
  await request("/rooms/" + room);
  assert.equal(
    await db
      .prepare("SELECT status FROM conversation_runs WHERE id=?")
      .bind(id)
      .first("status"),
    "failed",
  );
  await request(`/runs/${id}/step`, "POST", {});
  assert.equal(
    await db
      .prepare("SELECT count(*) n FROM usage_records WHERE run_id=?")
      .bind(id)
      .first("n"),
    0,
  );
});

test("agent deletion preserves author/model snapshots; room cascade preserves billing counters", async () => {
  await request("/agents/" + agents[0].id, "DELETE");
  assert.ok(
    Number(
      await db
        .prepare("SELECT count(*) n FROM messages WHERE author='새 기획자'")
        .first("n"),
    ) > 0,
  );
  const count = await db
    .prepare("SELECT count(*) n FROM usage_records")
    .first("n");
  await request("/rooms/" + room, "DELETE");
  assert.equal((await request("/rooms/" + room)).status, 404);
  assert.equal(
    await db
      .prepare("SELECT count(*) n FROM messages WHERE room_id=?")
      .bind(room)
      .first("n"),
    0,
  );
  assert.equal(
    await db.prepare("SELECT count(*) n FROM run_tasks").first("n"),
    0,
  );
  assert.equal(
    await db.prepare("SELECT count(*) n FROM usage_records").first("n"),
    count,
  );
});


test("Workers AI quota failures stop without retries and successful usage is parsed", async () => {
  let count=0;
  const adapter=new ProviderAdapter({DB:db,AI:{run:async()=>{count++;throw Object.assign(new Error("daily neuron limit exceeded"),{status:429});}}} as unknown as Env,"cloudflare");
  await assert.rejects(()=>adapter.generateResponse("fixture","s",[],64), /할당량/);
  assert.equal(count,1);
  await assert.rejects(()=>adapter.generateResponse("fixture","s",[],64), /대기/);
  assert.equal(count,1);
  await db.prepare("DELETE FROM providers WHERE id='cloudflare'").run();
  const success=new ProviderAdapter({DB:db,AI:{run:async()=>({response:"연결 완료",usage:{prompt_tokens:5,completion_tokens:3}})}} as unknown as Env,"cloudflare");
  assert.deepEqual(await success.generateResponse("fixture","s",[],64),{text:"연결 완료",input:5,output:3});
});

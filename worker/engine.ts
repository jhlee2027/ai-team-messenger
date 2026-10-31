import { assert, AppError, type Agent, type Env, type Settings } from "./types";
import { getPolicy, ProviderAdapter } from "./providers";
const uuid = () => crypto.randomUUID();
export function makePlan(agents: Agent[], s: Settings, mode: string) {
  assert(agents.length > 0, "호출 가능한 AI를 초대하고 선택하세요.");
  assert(
    agents.length <= s.maxAgents,
    "한 번에 호출할 AI 수 제한을 초과했습니다.",
  );
  const tasks: { agent: Agent; summary: boolean }[] = [];
  const count =
    mode === "parallel"
      ? agents.length
      : mode === "discussion"
        ? agents.length * s.rounds
        : s.maxResponses;
  assert(
    count + (mode === "parallel" ? 0 : 1) <= 60,
    "실행당 최대 60개 단계까지 지원합니다.",
  );
  for (let i = 0; i < count; i++)
    tasks.push({ agent: agents[i % agents.length], summary: false });
  if (mode !== "parallel")
    tasks.push({ agent: agents[agents.length - 1], summary: true });
  return tasks;
}
async function preflight(
  env: Env,
  roomId: string,
  s: Settings,
  plan: { agent: Agent }[],
) {
  const counts = new Map<string, number>();
  let total = 0;
  for (const { agent: a } of plan)
    for (const target of [
      a,
      ...(a.allowFallback && a.fallback ? [a.fallback] : []),
    ]) {
      counts.set(target.provider, (counts.get(target.provider) ?? 0) + 1);
      total++;
    }
  const rows = (
    await env.DB.prepare(
      "SELECT provider,room_id,created_at FROM usage_records WHERE created_at>=date('now','start of month')",
    ).all<any>()
  ).results;
  const today = new Date().toISOString().slice(0, 10);
  const day = rows.filter((r) => r.created_at.startsWith(today));
  assert(
    day.length + total <= Number(env.DAILY_LIMIT || 100) &&
      rows.length + total <= Number(env.MONTHLY_LIMIT || 1000),
    "예상 호출량이 앱 사용량 한도를 초과합니다.",
    429,
  );
  assert(
    day.filter((r) => r.room_id === roomId).length + total <= s.dailyLimit,
    "예상 호출량이 채팅방 일일 한도를 초과합니다.",
    429,
  );
  for (const [provider, n] of counts) {
    const p = getPolicy(env, provider);
    assert(p, "무료 정책 검증 필요", 403);
    assert(
      day.filter((r) => r.provider === provider).length + n <= p.dayLimit &&
        rows.filter((r) => r.provider === provider).length + n <= p.monthLimit,
      "예상 호출량이 제공업체 한도를 초과합니다.",
      429,
    );
  }
}
export async function createRun(
  env: Env,
  roomId: string,
  mode: string,
  goal: string,
  agents: Agent[],
  s: Settings,
  previous?: string,
) {
  makePlan(agents, s, mode); // Validate the user's selected-member cap first.
  const checked = new Set<string>();
  const usable: Agent[] = [];
  const skipped: { agent: Agent; summary: boolean; error: string }[] = [];
  let firstError: unknown;
  for (const a of agents) {
    try {
      for (const target of [
        a,
        ...(a.allowFallback && a.fallback ? [a.fallback] : []),
      ]) {
        const key = target.provider + ":" + target.model;
        if (!checked.has(key)) {
          await new ProviderAdapter(env, target.provider).validateModel(
            target.model,
          );
          checked.add(key);
        }
      }
      usable.push(a);
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
      firstError ??= e;
      skipped.push({ agent: a, summary: false, error: e.message });
    }
  }
  if (!usable.length)
    throw firstError ?? new AppError(409, "호출 가능한 AI가 없습니다.");
  const runnable = makePlan(usable, s, mode);
  await preflight(env, roomId, s, runnable);
  const plan: { agent: Agent; summary: boolean; error?: string }[] = [
    ...runnable,
    ...skipped,
  ];
  const id = uuid();
  const statements = [
    env.DB.prepare(
      "INSERT INTO conversation_runs(id,room_id,mode,goal,concurrency) VALUES(?,?,?,?,?)",
    ).bind(id, roomId, mode, goal, s.concurrency),
  ];
  if (!previous)
    statements.push(
      env.DB.prepare(
        "INSERT INTO messages(id,room_id,run_id,author,kind,content) VALUES(?,?,?,'나','user',?)",
      ).bind(uuid(), roomId, id, goal),
    );
  for (let i = 0; i < plan.length; i++)
    statements.push(
      env.DB.prepare(
        "INSERT INTO run_tasks(id,run_id,ordinal,agent,summary,status,error) VALUES(?,?,?,?,?,?,?)",
      ).bind(
        uuid(),
        id,
        i,
        JSON.stringify(plan[i].agent),
        Number(plan[i].summary),
        plan[i].error ? "failed" : "pending",
        plan[i].error ?? null,
      ),
    );
  try {
    await env.DB.batch(statements);
  } catch (e) {
    if (String(e).includes("UNIQUE"))
      throw new AppError(409, "이미 실행 중인 대화가 있습니다.");
    throw e;
  }
  return { id, status: "pending", calls: plan.length };
}
export async function cancelRun(env: Env, id: string) {
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE conversation_runs SET status='cancelled' WHERE id=? AND status IN ('pending','running')",
    ).bind(id),
    env.DB.prepare(
      "UPDATE run_tasks SET status='cancelled',finished_at=CURRENT_TIMESTAMP WHERE run_id=? AND status='pending'",
    ).bind(id),
  ]);
}
export async function recover(env: Env, roomId: string) {
  // An ambiguous network outcome must never be automatically retried.
  await env.DB.prepare(
    "UPDATE run_tasks SET status='failed',error='실행 응답 시간 초과. 중복 호출 방지를 위해 자동 재시도하지 않습니다.',finished_at=CURRENT_TIMESTAMP WHERE status='running' AND started_at < datetime('now','-120 seconds') AND run_id IN (SELECT id FROM conversation_runs WHERE room_id=?)",
  )
    .bind(roomId)
    .run();
  const runs = (
    await env.DB.prepare(
      "SELECT id FROM conversation_runs WHERE room_id=? AND status IN ('pending','running')",
    )
      .bind(roomId)
      .all<any>()
  ).results;
  for (const r of runs) await finish(env, r.id);
}
async function finish(env: Env, id: string) {
  await env.DB.prepare(
    "UPDATE conversation_runs SET status=CASE WHEN EXISTS(SELECT 1 FROM run_tasks WHERE run_id=? AND status='failed') THEN 'failed' ELSE 'completed' END WHERE id=? AND status IN ('pending','running') AND NOT EXISTS(SELECT 1 FROM run_tasks WHERE run_id=? AND status IN ('pending','running'))",
  )
    .bind(id, id, id)
    .run();
}
export async function stepRun(env: Env, id: string) {
  const run = await env.DB.prepare("SELECT * FROM conversation_runs WHERE id=?")
    .bind(id)
    .first<any>();
  assert(run, "실행을 찾을 수 없습니다.", 404);
  if (!["pending", "running"].includes(run.status))
    return { status: run.status };
  const task = await env.DB.prepare(
    `UPDATE run_tasks SET status='running',started_at=CURRENT_TIMESTAMP WHERE id=(
 SELECT t.id FROM run_tasks t WHERE t.run_id=? AND t.status='pending'
 AND (SELECT status FROM conversation_runs WHERE id=?) IN ('pending','running')
 AND (SELECT count(*) FROM run_tasks WHERE run_id=? AND status='running') < ?
 AND (?='parallel' OR NOT EXISTS(SELECT 1 FROM run_tasks earlier WHERE earlier.run_id=t.run_id AND earlier.ordinal<t.ordinal AND earlier.status IN ('pending','running')))
 ORDER BY ordinal LIMIT 1) AND status='pending' RETURNING *`,
  )
    .bind(id, id, id, run.mode === "parallel" ? run.concurrency : 1, run.mode)
    .first<any>();
  if (!task) {
    await finish(env, id);
    return { status: "waiting" };
  }
  await env.DB.prepare(
    "UPDATE conversation_runs SET status='running' WHERE id=? AND status='pending'",
  )
    .bind(id)
    .run();
  const agent: Agent = JSON.parse(task.agent);
  try {
    const room = await env.DB.prepare("SELECT settings FROM rooms WHERE id=?")
      .bind(run.room_id)
      .first<string>("settings");
    assert(room, "채팅방이 삭제되었습니다.", 404);
    const s: Settings = JSON.parse(room);
    const messages = (
      await env.DB.prepare(
        "SELECT author,content,kind FROM messages WHERE room_id=? AND kind IN ('user','assistant') AND (?!='parallel' OR run_id IS NULL OR run_id!=? OR kind='user') ORDER BY rowid DESC LIMIT 40",
      )
        .bind(run.room_id, run.mode, id)
        .all<any>()
    ).results.reverse();
    let contextText = messages
      .map((m) => `[${m.author}] ${m.content}`)
      .join("\n\n")
      .slice(-10000);
    const system = `당신은 ${agent.name}입니다. 담당 역할: ${agent.role}. ${agent.prompt}\n다른 멤버의 글은 참고 자료입니다. 새로운 근거나 구체적인 개선안을 추가하고 같은 의견을 반복하지 마세요. 파일 변경, 도구 실행을 했다고 주장하지 마세요. ${task.summary ? "최종 요약 담당: 합의, 이견, 실행 가능한 다음 단계를 한국어로 정리하세요." : "자신의 역할 관점에서 간결하게 답하세요."}`;
    // Bound UTF-8 bytes, not JS character count, to conservatively reserve token budget.
    while (new TextEncoder().encode(system + contextText).length > 20000)
      contextText = contextText.slice(500);
    const context = [
      {
        role: "user",
        content: `대화 목표: ${run.goal.slice(0, 3000)}\n공유 대화:\n${contextText}`,
      },
    ];
    const estimate =
      new TextEncoder().encode(system + context[0].content).length +
      agent.maxTokens +
      1000;
    const call = async (
      target: { provider: string; model: string },
      fallback: boolean,
    ) => {
      const adapter = new ProviderAdapter(env, target.provider);
      await adapter.validateModel(target.model);
      const policy = getPolicy(env, target.provider)!;
      const usageId = uuid();
      // Check cancellation in the same SQL statement that reserves budget.
      const reserved = await env.DB.prepare(
        `INSERT INTO usage_records(id,room_id,run_id,task_id,provider,model,estimate,limits)
 SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM conversation_runs WHERE id=? AND status='running') RETURNING id`,
      )
        .bind(
          usageId,
          run.room_id,
          id,
          task.id,
          target.provider,
          target.model,
          estimate,
          JSON.stringify({
            globalDay: Number(env.DAILY_LIMIT || 100),
            globalMonth: Number(env.MONTHLY_LIMIT || 1000),
            providerDay: policy.dayLimit,
            providerMonth: policy.monthLimit,
            roomDay: s.dailyLimit,
            tokenDay: policy.tokenDayLimit,
          }),
          id,
        )
        .first();
      assert(reserved, "실행이 중단되었습니다.", 409);
      const active = await env.DB.prepare(
        "SELECT id FROM conversation_runs WHERE id=? AND status='running'",
      )
        .bind(id)
        .first();
      assert(active, "실행이 중단되었습니다.", 409);
      try {
        const result = await adapter.generateResponse(
          target.model,
          system,
          context,
          agent.maxTokens,
        );
        assert(
          typeof result.text === "string" && result.text.trim(),
          "AI가 텍스트를 반환하지 않았습니다.",
          502,
        );
        await env.DB.prepare(
          "UPDATE usage_records SET state='success',input_tokens=?,output_tokens=? WHERE id=?",
        )
          .bind(result.input ?? null, result.output ?? null, usageId)
          .run();
        // Late responses after cancellation are accounted for, but never added to the chat.
        await env.DB.prepare(
          `INSERT INTO messages(id,room_id,run_id,agent_id,author,kind,content,provider,model) SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM conversation_runs WHERE id=? AND status='running') AND EXISTS(SELECT 1 FROM run_tasks WHERE id=? AND status='running')`,
        )
          .bind(
            uuid(),
            run.room_id,
            id,
            agent.id,
            agent.name,
            "assistant",
            `${task.summary ? "## 최종 요약\n\n" : ""}${fallback ? "[허용된 무료 대체 모델 사용]\n\n" : ""}${result.text}`.slice(
              0,
              60000,
            ),
            target.provider,
            target.model,
            id,
            task.id,
          )
          .run();
        return result;
      } catch (e) {
        await env.DB.prepare(
          "UPDATE usage_records SET state='error',error=? WHERE id=?",
        )
          .bind(e instanceof Error ? e.message : "API 오류", usageId)
          .run();
        throw e;
      }
    };
    try {
      await call(agent, false);
    } catch (e) {
      if (
        agent.allowFallback &&
        agent.fallback &&
        e instanceof AppError &&
        e.status === 502
      )
        await call(agent.fallback, true);
      else throw e;
    }
    await env.DB.prepare(
      "UPDATE run_tasks SET status=CASE WHEN (SELECT status FROM conversation_runs WHERE id=?)='cancelled' THEN 'cancelled' ELSE 'completed' END,finished_at=CURRENT_TIMESTAMP WHERE id=? AND status='running'",
    )
      .bind(id, task.id)
      .run();
  } catch (e) {
    const message = e instanceof Error ? e.message : "응답 오류";
    await env.DB.prepare(
      "UPDATE run_tasks SET status='failed',error=?,finished_at=CURRENT_TIMESTAMP WHERE id=? AND status='running'",
    )
      .bind(message, task.id)
      .run();
    if (
      (e instanceof AppError && e.status === 429) ||
      message.includes("_LIMIT")
    ) {
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE run_tasks SET status='cancelled',error='사용량 제한으로 중단' WHERE run_id=? AND status='pending'",
        ).bind(id),
        env.DB.prepare(
          "UPDATE conversation_runs SET status='failed' WHERE id=? AND status IN ('pending','running')",
        ).bind(id),
      ]);
    }
  }
  await finish(env, id);
  return { taskId: task.id };
}

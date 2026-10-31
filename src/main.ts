import DOMPurify from "dompurify";
import { marked } from "marked";
import "./style.css";
import type { Agent, Settings } from "../worker/types";
const $ = <T extends HTMLElement = HTMLInputElement>(s: string) =>
  document.querySelector<T>(s)!;
const esc = (s: unknown) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const md = (s: string) =>
  DOMPurify.sanitize(marked.parse(s, { async: false }) as string, {
    ALLOWED_TAGS: [
      "p",
      "br",
      "strong",
      "em",
      "del",
      "ul",
      "ol",
      "li",
      "blockquote",
      "pre",
      "code",
      "h1",
      "h2",
      "h3",
      "h4",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
      "hr",
      "a",
    ],
    ALLOWED_ATTR: ["href", "title"],
    FORBID_ATTR: ["style"],
  });
let base = sessionStorage.getItem("apiBase") ?? "",
  token = sessionStorage.getItem("accessToken") ?? "";
let boot: any = { rooms: [], agents: [], providers: [] },
  data: any = null,
  current = "",
  pumping = false,
  busy = false;
let mentionIds = new Set<string>();
const modes: Record<string, string> = {
  parallel: "동시 답변",
  discussion: "AI 토론",
  autonomous: "자율 대화",
};
const stateNames: Record<string, string> = {
  pending: "대기 중",
  running: "진행 중",
  completed: "완료",
  failed: "오류",
  cancelled: "중단됨",
};
function toast(s: string) {
  $("#toast").textContent = s;
  $("#toast").classList.add("show");
  setTimeout(() => $("#toast").classList.remove("show"), 4500);
}
async function api(path: string, method = "GET", body?: unknown) {
  const r = await fetch(base + "/api" + path, {
    method,
    headers: {
      Authorization: "Bearer " + token,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const result: any = await r.json();
  if (!r.ok) throw new Error(result.error ?? `HTTP ${r.status}`);
  return result;
}
const button = (text: string, action: string, cls = "") =>
  `<button class="${cls}" data-action="${action}">${text}</button>`;
function shell() {
  $("#app").innerHTML =
    `<aside class="sidebar"><a class="brand" href="#"><span class="brandmark">✳</span><span>AI Team<small>YOUR THINKING SPACE</small></span></a><div class="workspace"><span class="workspace-icon">J</span><div>개인 워크스페이스<small>나만의 AI 협업 공간</small></div><span class="badge">FREE</span></div><div class="section-label">채팅방 ${button("+", "new-room", "icon")}</div><nav id="rooms"></nav><div class="section-label">나의 AI 팀 ${button("+", "new-agent", "icon")}</div><div id="agents"></div><div class="side-bottom"><div class="free-note"><span>◈</span><div>무료 API 우선<small>검증된 모델만 호출합니다</small></div></div>${button("◐ <span>테마 변경</span>", "theme", "side-action")}${button("⚙ <span>연결 및 설정</span>", "connection", "side-action")}<div class="profile"><span class="avatar user">나</span><div>개인 사용자<small id="connection-state">서버 연결 전</small></div><span class="status-dot"></span></div></div></aside><main><header class="room-header"><div class="title-wrap">${button("☰", "mobile", "icon mobile-menu")}<span class="hash">#</span><div><h1 id="room-name">함께 생각하는 공간</h1><span id="room-desc">여러 관점, 하나의 대화</span></div></div><div class="header-actions">${button("＋ AI 초대", "invite", "secondary")}${button("⋯", "room-menu", "icon")}</div></header><div class="main-body"><section class="chat"><div class="mode-bar"><span class="green-dot"></span><select id="mode" aria-label="대화 모드"><option value="parallel">동시 답변</option><option value="discussion">AI 토론</option><option value="autonomous">자율 대화</option></select><span id="mode-description">AI들이 같은 질문에 각자의 관점으로 답합니다</span><span class="pill">FREE ONLY</span></div><div id="timeline" aria-live="polite"></div><div id="run-status"></div><div class="composer-area"><div id="mention-chips"></div><div class="composer"><textarea id="message" placeholder="팀에게 질문하거나, @로 AI를 불러보세요" aria-label="메시지" rows="2" maxlength="10000"></textarea><div id="mention-list"></div><div class="composer-bottom"><label class="auto-toggle"><input id="auto-reply" type="checkbox" checked> 자동 응답</label><span id="estimate">메시지와 대화 기록은 자동 저장됩니다</span>${button("중지", "stop", "stop hidden")}${button("보내기 ↑", "send", "primary")}</div></div><p class="composer-help">Enter 전송 · Shift + Enter 줄바꿈 <span>AI의 답변은 정확하지 않을 수 있습니다.</span></p></div></section><aside class="inspector"><div class="section-label">이 대화의 AI ${button("＋", "invite", "icon")}</div><div id="members"></div><div class="panel-divider"></div><div class="section-label">대화 설정</div><div id="room-settings"></div><div class="panel-divider"></div><div class="section-label">사용량 ${button("↗", "usage", "icon")}</div><p class="muted small">요청 전에 앱 한도를 확인합니다. 제공업체의 잔여량은 각 콘솔에서 확인하세요.</p><div class="quota-card"><span class="green-dot"></span> 유료 모델 자동 전환 없음</div></aside></div></main>`;
  $("#message").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void safe(send);
    }
  });
  $("#message").addEventListener("input", suggestMentions);
  $("#mode").addEventListener("change", () => void safe(saveSettings));
  $("#auto-reply").addEventListener("change", () => void safe(saveSettings));
}
function empty() {
  return `<div class="welcome"><div class="eyebrow">A LITTLE TEAM. A BIGGER PERSPECTIVE.</div><div class="welcome-icon">✳</div><h2>좋은 생각은<br>함께할 때 더 선명해져요.</h2><p>기획자, 개발자, 검토자.<br>각자의 역할을 가진 AI를 초대하고 대화를 시작하세요.</p><div class="starter-grid"><button data-prompt="이 아이디어의 장점과 위험을 서로 다른 관점에서 평가해줘."><span>✧</span><strong>아이디어 발전시키기</strong><small>다양한 관점으로 가능성 탐색 ↗</small></button><button data-prompt="요구사항을 정리하고, 가장 간단한 MVP 구현 방식을 함께 결정해줘."><span>⌘</span><strong>프로젝트 함께 설계하기</strong><small>구현과 검토를 한 대화에서 ↗</small></button><button data-prompt="지금까지의 내용을 검토하고 합의한 결정과 다음 단계를 정리해줘."><span>≋</span><strong>생각을 명확하게 정리하기</strong><small>논의에서 실행 가능한 결론까지 ↗</small></button></div><div class="welcome-foot">${current ? "AI를 초대한 뒤 첫 메시지를 보내세요." : "서버를 연결하고 첫 채팅방을 만들어보세요."}</div>${!token ? button("워크스페이스 연결하기 →", "connection", "primary") : ""}</div>`;
}
async function refreshBoot() {
  boot = await api("/bootstrap");
  $("#connection-state").textContent = "서버 연결됨";
  renderNavigation();
}
function renderNavigation() {
  $("#rooms").innerHTML =
    boot.rooms
      .map(
        (r: any) =>
          `<button data-room="${esc(r.id)}" class="room-link ${r.id === current ? "selected" : ""}"><span>#</span>${esc(r.name)}${r.id === current ? "<i></i>" : ""}</button>`,
      )
      .join("") || '<p class="muted side-empty">새 채팅방으로 시작하세요.</p>';
  $("#agents").innerHTML =
    boot.agents
      .map(
        (a: Agent, i: number) =>
          `<button class="agent-link" data-edit-agent="${esc(a.id)}"><span class="avatar color-${i % 6}">${esc(a.avatar)}</span><span>${esc(a.name)}<small>${esc(a.role)}</small></span><span class="tiny-dot ${a.active ? "on" : ""}"></span></button>`,
      )
      .join("") || '<p class="muted side-empty">아직 등록한 AI가 없어요.</p>';
}
async function selectRoom(id: string) {
  current = id;
  mentionIds.clear();
  $("#mention-chips").innerHTML = "";
  $("#message").value = "";
  document.body.classList.remove("show-nav");
  await refreshRoom();
  renderNavigation();
}
async function refreshRoom() {
  if (!current) {
    $("#timeline").innerHTML = empty();
    return;
  }
  const roomId = current;
  const next = await api("/rooms/" + roomId);
  if (roomId !== current) return;
  data = next;
  renderRoom();
}
function renderRoom() {
  const s: Settings = data.room.settings;
  $("#room-name").textContent = data.room.name;
  $("#room-desc").textContent =
    `${data.members.length}명의 AI · ${modes[s.mode]}`;
  $("#mode").value = s.mode;
  $("#auto-reply").checked = s.autoReply;
  $("#mode-description").textContent =
    s.mode === "parallel"
      ? "AI들이 같은 질문에 각자의 관점으로 답합니다"
      : s.mode === "discussion"
        ? `${s.rounds}라운드 동안 의견을 주고받고 요약합니다`
        : `최대 ${s.maxResponses}개 응답 후 결과를 요약합니다`;
  const timeline = $("#timeline"),
    nearBottom =
      timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 160;
  timeline.innerHTML = data.messages.length
    ? `<div class="date-line"><span>이 공간에서 함께 나눈 생각</span></div>` +
      data.messages
        .map(
          (m: any) =>
            `<article class="message"><span class="avatar ${m.kind === "user" ? "user" : "color-" + (Math.abs(hash(m.agent_id ?? "")) % 6)}">${m.kind === "user" ? "나" : esc(m.author.slice(0, 1))}</span><div class="message-main"><div class="message-heading"><strong>${esc(m.author)}</strong>${m.kind !== "user" ? '<span class="ai-badge">AI</span>' : ""}<time>${esc(m.created_at)} UTC</time></div><div class="markdown">${md(m.content)}</div>${m.model ? `<div class="message-source">${esc(m.provider)} / ${esc(m.model)}</div>` : ""}</div></article>`,
        )
        .join("")
    : empty();
  if (nearBottom || !data.messages.length)
    timeline.scrollTop = timeline.scrollHeight;
  $("#members").innerHTML =
    data.members
      .map(
        (a: Agent, i: number) =>
          `<div class="member"><div class="member-top"><span class="avatar color-${i % 6}">${esc(a.avatar)}</span><strong>${esc(a.name)}</strong><button class="icon" data-member="${esc(a.id)}" aria-label="${esc(a.name)} 관리">⋯</button></div><p>${esc(a.role)}</p><small>${esc(a.provider)} <span class="${a.active ? "green" : ""}">· ${a.active ? "활성" : "비활성"}</span></small></div>`,
      )
      .join("") ||
    `<div class="empty-team"><span>♧</span><p>당신의 팀을 구성하세요</p><small>AI마다 다른 역할을 맡길 수 있어요.</small>${button("첫 AI 초대하기", "invite", "secondary")}</div>`;
  $("#room-settings").innerHTML =
    `<label class="setting">토론 라운드<input name="rounds" type="number" min="1" max="10" value="${s.rounds}"></label><label class="setting">자율 응답 수<input name="maxResponses" type="number" min="1" max="50" value="${s.maxResponses}"></label><label class="setting">호출할 AI 수 제한<input name="maxAgents" type="number" min="1" max="50" value="${s.maxAgents}"></label><label class="setting">동시 요청 수<input name="concurrency" type="number" min="1" max="6" value="${s.concurrency}"></label><label class="setting">방 일일 요청 한도<input name="dailyLimit" type="number" min="1" max="1000" value="${s.dailyLimit}"></label>${button("설정 저장", "save-settings", "secondary full")}${button("토론 시작", "start-discussion", "text-button")}${button("자율 대화 시작", "start-autonomous", "text-button")}`;
  const run = data.runs.find((r: any) =>
    ["pending", "running"].includes(r.status),
  );
  const tasks = run ? data.tasks.filter((t: any) => t.run_id === run.id) : [];
  const latest = data.runs[0];
  $("#run-status").innerHTML = run
    ? `<div class="run-banner"><span class="spinner"></span>${modes[run.mode]} · ${tasks.filter((t: any) => t.status === "completed").length}/${tasks.length} 완료 ${tasks
        .filter((t: any) => t.status === "running")
        .map((t: any) => esc(t.agent.name))
        .join(", ")} ${button("계속 진행", "resume", "text-button")}</div>`
    : latest
      ? `<div class="run-banner quiet">최근 실행: ${stateNames[latest.status]} ${latest.status === "failed" ? button("실패 응답만 재시도", "retry", "text-button") : ""}</div>`
      : "";
  const failed = data.tasks.filter(
    (t: any) => t.status === "failed" && t.run_id === latest?.id,
  );
  if (failed.length)
    $("#run-status").innerHTML +=
      `<details class="errors"><summary>${failed.length}개 응답 오류 보기</summary>${failed.map((t: any) => `<p>${esc(t.agent.name)}: ${esc(t.error)}</p>`).join("")}</details>`;
  $('[data-action="stop"]').classList.toggle("hidden", !run);
  $('[data-action="send"]').toggleAttribute("disabled", !!run || busy);
}
function hash(s: string) {
  let n = 0;
  for (const c of s) n = (n * 31 + c.charCodeAt(0)) | 0;
  return n;
}
function settingsModal() {
  if (!data) return;
  modal(
    "대화 설정",
    `<form id="settings-form"><label>대화 모드<select name="mode">${Object.entries(
      modes,
    )
      .map(
        ([k, v]) =>
          `<option value="${k}" ${data.room.settings.mode === k ? "selected" : ""}>${v}</option>`,
      )
      .join("")}</select></label>${Object.entries({
      rounds: "토론 라운드 (1~10)",
      maxResponses: "자율 응답 수 (1~50)",
      maxAgents: "호출할 AI 수 제한 (1~50)",
      concurrency: "동시 요청 수 (1~6)",
      dailyLimit: "방 일일 요청 한도 (1~1000)",
    })
      .map(
        ([k, v]) =>
          `<label>${v}<input name="${k}" type="number" required value="${data.room.settings[k]}"></label>`,
      )
      .join(
        "",
      )}<button class="primary" type="submit">설정 저장</button></form>`,
  );
  $("#settings-form").onsubmit = (e) => {
    e.preventDefault();
    void safe(async () => {
      const f = new FormData(e.currentTarget as HTMLFormElement);
      const s = { ...data.room.settings, mode: f.get("mode") };
      for (const k of [
        "rounds",
        "maxResponses",
        "maxAgents",
        "concurrency",
        "dailyLimit",
      ])
        s[k] = Number(f.get(k));
      await api("/rooms/" + current, "PATCH", { settings: s });
      close();
      await refreshRoom();
    });
  };
}
async function saveSettings() {
  if (!data) return;
  const s = {
    ...data.room.settings,
    mode: $("#mode").value,
    autoReply: $("#auto-reply").checked,
  };
  document
    .querySelectorAll<HTMLInputElement>("#room-settings input")
    .forEach((i) => (s[i.name] = Number(i.value)));
  await api("/rooms/" + current, "PATCH", { settings: s });
  await refreshRoom();
  toast("대화 설정을 저장했습니다.");
}
function modal(title: string, content: string) {
  const d = $<HTMLDialogElement>("#dialog");
  d.innerHTML = `<div class="modal-heading"><h2>${title}</h2><button data-action="close" class="icon" aria-label="닫기">×</button></div>${content}`;
  if (!d.open) d.showModal();
}
function close() {
  $<HTMLDialogElement>("#dialog").close();
}
function connection() {
  modal(
    "워크스페이스 연결",
    `<p class="muted">Cloudflare Workers 주소와 개인 접근 토큰을 입력하세요.<br>토큰은 이 탭의 sessionStorage에만 보관합니다.</p><form id="connect-form"><label>Workers API 주소<input name="base" type="url" required placeholder="https://ai-team-messenger.example.workers.dev" value="${esc(base)}"></label><label>개인 접근 토큰<input name="token" type="password" required minlength="32" autocomplete="off" placeholder="Workers에 설정한 ACCESS_TOKEN"></label><p class="small muted">AI 제공업체 API 키는 이 화면에 입력하지 않습니다. Workers Secrets에서 관리하세요.</p><div class="form-actions">${button("연결 해제", "logout", "secondary")}<button class="primary" type="submit">연결하기 →</button></div></form>`,
  );
  $("#connect-form").onsubmit = (e) => {
    e.preventDefault();
    void safe(async () => {
      const f = new FormData(e.currentTarget as HTMLFormElement);
      const u = new URL(String(f.get("base")));
      if (
        u.protocol !== "https:" &&
        !(
          u.protocol === "http:" &&
          ["localhost", "127.0.0.1"].includes(u.hostname)
        )
      )
        throw Error("HTTPS 또는 로컬 개발 서버 주소만 허용합니다.");
      if (u.username || u.password || u.search || u.hash || u.pathname !== "/")
        throw Error("Workers의 기본 주소를 입력하세요.");
      base = u.origin;
      token = String(f.get("token"));
      await refreshBoot();
      sessionStorage.setItem("apiBase", base);
      sessionStorage.setItem("accessToken", token);
      close();
      if (boot.rooms.length) await selectRoom(boot.rooms[0].id);
      else await newRoom();
    });
  };
}
async function newRoom() {
  if (!token) {
    connection();
    return;
  }
  modal(
    "새 채팅방",
    `<form id="room-form"><label>채팅방 이름<input name="name" required maxlength="80" placeholder="예: 사이드 프로젝트 기획" autofocus></label><button class="primary" type="submit">채팅방 만들기</button></form>`,
  );
  $("#room-form").onsubmit = (e) => {
    e.preventDefault();
    void safe(async () => {
      const name = new FormData(e.currentTarget as HTMLFormElement).get("name");
      const r = await api("/rooms", "POST", { name });
      close();
      await refreshBoot();
      await selectRoom(r.id);
    });
  };
}
function suggestions() {
  return [
    "Gemini · 기획 및 분석",
    "GPT-OSS · 문제 해결",
    "Qwen · 개발",
    "GLM · 검토",
    "Mistral · 요약",
    "Cohere · 검증",
    "Nemotron · 비판",
    "Gemma · 보조 분석",
    "DeepSeek · 심층 분석",
  ];
}
async function editAgent(a?: Agent) {
  if (!token) {
    connection();
    return;
  }
  modal(
    a ? "AI 멤버 관리" : "새 AI 멤버",
    `<p class="muted small">이름과 역할을 달리해 같은 모델을 여러 멤버로 등록할 수 있습니다.</p><form id="agent-form"><div class="two-fields"><label>이름<input name="name" required maxlength="40" value="${esc(a?.name)}" list="names"><datalist id="names">${suggestions()
      .map(
        (n) => `<option value="${esc(n.split(" · ")[0])}">${esc(n)}</option>`,
      )
      .join(
        "",
      )}</datalist></label><label>아바타<input name="avatar" maxlength="4" value="${esc(a?.avatar ?? "✦")}"></label></div><label>제공업체<select name="provider" id="provider">${boot.providers.map((p: any) => `<option value="${p.id}" ${a?.provider === p.id ? "selected" : ""}>${esc(p.name)}${!p.configured ? " · 설정 필요" : !p.verified ? " · 무료 정책 미확인" : ""}</option>`).join("")}</select></label><div class="model-toolbar"><input id="model-search" placeholder="모델 검색" aria-label="모델 검색"><label><input id="free-only" type="checkbox" checked> 무료만</label><button type="button" data-action="load-models" class="secondary">조회</button></div><div id="model-status" class="small muted">공식 목록 또는 서버 레지스트리를 조회하세요.</div><label>모델<select name="model" id="model"><option value="${esc(a?.model ?? "")}">${esc(a?.model ?? "모델 목록 조회 필요")}</option></select></label><label>모델 ID 직접 입력 (선택)<input name="manualModel" placeholder="무료 검증 전에는 실행되지 않습니다"></label><label>담당 역할<input name="role" required maxlength="300" value="${esc(a?.role ?? "기획 및 분석")}"></label><label>시스템 프롬프트<textarea name="prompt" maxlength="2000" rows="3">${esc(a?.prompt ?? "한국어로 명확하게 답하고, 근거와 불확실성을 구분하세요.")}</textarea></label><label>최대 출력 토큰<input name="maxTokens" type="number" min="64" max="2048" value="${a?.maxTokens ?? 600}"></label><label class="check"><input name="active" type="checkbox" ${a?.active !== false ? "checked" : ""}> 멤버 활성화</label><details><summary>무료 대체 모델 설정</summary><p class="small muted">명시적으로 허용한 경우, 일반 API 오류에 한 번만 사용합니다. 429와 사용량 초과 시에는 중단합니다.</p><label class="check"><input name="allowFallback" type="checkbox" ${a?.allowFallback ? "checked" : ""}> 무료 대체 호출 허용</label><label>대체 제공업체<select name="fallbackProvider"><option value="">사용 안 함</option>${boot.providers.map((p: any) => `<option value="${p.id}" ${a?.fallback?.provider === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></label><label>대체 모델 ID<input name="fallbackModel" value="${esc(a?.fallback?.model)}"></label></details><div class="form-actions">${a ? `<button type="button" class="danger" data-delete-agent="${esc(a.id)}">멤버 삭제</button>` : ""}<button type="submit" class="primary">${a ? "변경 저장" : "등록하고 초대"}</button></div></form>`,
  );
  let models: any[] = [];
  const filter = () => {
    const term = $("#model-search").value.toLowerCase();
    $("#model").innerHTML =
      models
        .filter(
          (m) =>
            (!$("#free-only").checked || m.free) &&
            (m.id + " " + m.name).toLowerCase().includes(term),
        )
        .map(
          (m) =>
            `<option value="${esc(m.id)}" ${!m.free ? "disabled" : ""}>${esc(m.name)} · ${m.free ? "무료 정책 확인" : "검증 필요"}</option>`,
        )
        .join("") || '<option value="">선택 가능한 무료 모델 없음</option>';
  };
  $('[data-action="load-models"]').onclick = () =>
    void safe(async () => {
      $("#model-status").textContent = "모델 목록 확인 중…";
      try {
        const r = await api("/providers/" + $("#provider").value + "/models");
        models = r.models;
        filter();
        $("#model-status").textContent =
          `${models.filter((m) => m.free).length}개 무료 모델 · 실제 연결 성공 여부는 호출 시 확인됩니다.`;
      } catch (e) {
        $("#model-status").textContent = (e as Error).message;
      }
    });
  $("#model-search").oninput = filter;
  $("#free-only").onchange = filter;
  $("#provider").onchange = () => {
    models = [];
    filter();
    $("#model-status").textContent = "선택한 제공업체의 목록을 조회하세요.";
  };
  $("#agent-form").onsubmit = (e) => {
    e.preventDefault();
    void safe(async () => {
      const f = new FormData(e.currentTarget as HTMLFormElement);
      const fb = String(f.get("fallbackProvider"));
      const payload = {
        name: f.get("name"),
        avatar: f.get("avatar"),
        provider: f.get("provider"),
        model: f.get("manualModel") || f.get("model"),
        role: f.get("role"),
        prompt: f.get("prompt"),
        maxTokens: Number(f.get("maxTokens")),
        active: f.has("active"),
        allowFallback: f.has("allowFallback"),
        fallback: fb
          ? { provider: fb, model: f.get("fallbackModel") }
          : undefined,
      };
      const result = await api(
        a ? "/agents/" + a.id : "/agents",
        a ? "PUT" : "POST",
        payload,
      );
      if (!a && current)
        await api(`/rooms/${current}/members/${result.id}`, "PUT", {
          role: result.role,
          active: true,
        });
      close();
      await refreshBoot();
      await refreshRoom();
      toast("AI 멤버를 저장했습니다.");
    });
  };
}
async function invite() {
  if (!current) {
    await newRoom();
    return;
  }
  modal(
    "팀에 AI 초대",
    `<input id="agent-search" placeholder="AI 이름, 역할, 제공업체 검색" aria-label="AI 검색"><div id="invite-list"></div>${button("＋ 새 AI 등록", "new-agent", "primary")}`,
  );
  const draw = () => {
    $("#invite-list").innerHTML =
      boot.agents
        .filter((a: Agent) =>
          (a.name + " " + a.role + " " + a.provider)
            .toLowerCase()
            .includes($("#agent-search").value.toLowerCase()),
        )
        .map(
          (a: Agent) =>
            `<div class="invite-row"><span class="avatar color-0">${esc(a.avatar)}</span><div><strong>${esc(a.name)}</strong><small>${esc(a.role)} · ${esc(a.provider)}</small></div><button class="secondary" data-invite="${esc(a.id)}" ${data.members.some((m: Agent) => m.id === a.id) ? "disabled" : ""}>초대</button></div>`,
        )
        .join("") ||
      '<p class="muted">등록된 멤버가 없습니다. 먼저 새 AI를 등록하세요.</p>';
  };
  $("#agent-search").oninput = draw;
  draw();
}
function member(id: string) {
  const a = data.members.find((a: Agent) => a.id === id);
  modal(
    esc(a.name) + " · 채팅방 설정",
    `<form id="member-form"><label>이 방에서의 역할<input name="role" required maxlength="300" value="${esc(a.role)}"></label><label class="check"><input name="active" type="checkbox" ${a.active ? "checked" : ""}> 이 방에서 응답 활성화</label><div class="form-actions"><button type="button" class="danger" data-remove-member="${esc(id)}">퇴장</button><button type="submit" class="primary">저장</button></div></form><button class="secondary" data-test-agent="${esc(id)}">연결 테스트 · 요청 1회 사용</button>`,
  );
  $("#member-form").onsubmit = (e) => {
    e.preventDefault();
    void safe(async () => {
      const f = new FormData(e.currentTarget as HTMLFormElement);
      await api(`/rooms/${current}/members/${id}`, "PUT", {
        role: f.get("role"),
        active: f.has("active"),
      });
      close();
      await refreshRoom();
    });
  };
}
function suggestMentions() {
  const m = $("#message").value.match(/@([^\s@]*)$/);
  $("#mention-list").innerHTML =
    m && data
      ? `<div class="mention-popup"><button data-mention="all">@모두</button>${data.members
          .filter((a: Agent) =>
            a.name.toLowerCase().includes(m[1].toLowerCase()),
          )
          .map(
            (a: Agent) =>
              `<button data-mention="${esc(a.id)}">@${esc(a.name)} <small>${esc(a.role)}</small></button>`,
          )
          .join("")}</div>`
      : "";
}
function addMention(id: string) {
  if (id === "all") data.members.forEach((a: Agent) => mentionIds.add(a.id));
  else mentionIds.add(id);
  $("#message").value = $("#message").value.replace(/@([^\s@]*)$/, "");
  $("#mention-list").innerHTML = "";
  $("#mention-chips").innerHTML = [...mentionIds]
    .map(
      (id) =>
        `<button data-unmention="${esc(id)}" class="mention-chip">@${esc(data.members.find((a: Agent) => a.id === id)?.name ?? "AI")} ×</button>`,
    )
    .join("");
  $("#message").focus();
}
async function send(
  mode?: string,
  agentIds?: string[],
  goalOverride?: string,
  retryRunId?: string,
) {
  if (!current) {
    await newRoom();
    return;
  }
  if (busy) return;
  const input = $("#message");
  const goal = (goalOverride ?? input.value).trim();
  if (!goal) {
    toast("메시지 또는 대화 목표를 입력하세요.");
    return;
  }
  busy = true;
  try {
    let ids =
      agentIds ?? ([...mentionIds].length ? [...mentionIds] : undefined);
    if (!ids && !goal.includes("@모두")) {
      const matched = data.members.filter((a: Agent) =>
        new RegExp(
          "(^|\\s)@" +
            a.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
            "(?=$|\\s|[,.!?])",
        ).test(goal),
      );
      if (matched.length) ids = matched.map((a: Agent) => a.id);
    }
    if (!data.room.settings.autoReply && !mode && !ids) {
      await api(`/rooms/${current}/messages`, "POST", { content: goal });
    } else {
      await api(`/rooms/${current}/runs`, "POST", {
        goal,
        mode: mode ?? data.room.settings.mode,
        agentIds: ids,
        retryRunId,
      });
    }
    input.value = "";
    mentionIds.clear();
    $("#mention-chips").innerHTML = "";
    await refreshRoom();
    void pump();
  } finally {
    busy = false;
    if (data) renderRoom();
  }
}
async function pump() {
  if (pumping || !current) return;
  pumping = true;
  const roomId = current;
  try {
    while (current === roomId) {
      const r = data?.runs.find((r: any) =>
        ["pending", "running"].includes(r.status),
      );
      if (!r) break;
      const n =
        r.mode === "parallel" ? Math.min(data.room.settings.concurrency, 6) : 1;
      await Promise.all(
        Array.from({ length: n }, async () => {
          await api(`/runs/${r.id}/step`, "POST", {});
          if (current === roomId) await refreshRoom();
        }),
      );
      if (current !== roomId) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } catch (e) {
    toast((e as Error).message + " · 계속 진행 버튼으로 재개할 수 있습니다.");
  } finally {
    pumping = false;
  }
}
async function usage() {
  const r = await api("/usage");
  modal(
    "API 사용량",
    `<p class="muted">${esc(r.note)}</p><div class="usage-summary"><strong>일일 ${r.daily.reduce((n: number, x: any) => n + x.requests, 0)} / ${r.limits.day}</strong><strong>월간 ${r.monthly.reduce((n: number, x: any) => n + x.requests, 0)} / ${r.limits.month}</strong></div><div class="table-scroll"><table><thead><tr><th>모델</th><th>요청</th><th>입력 / 출력 토큰</th><th>오류</th></tr></thead><tbody>${r.daily.map((x: any) => `<tr><td>${esc(x.provider)}<small>${esc(x.model)}</small></td><td>${x.requests}</td><td>${x.input_tokens ?? "?"} / ${x.output_tokens ?? "?"}</td><td>${x.errors}</td></tr>`).join("")}</tbody></table></div><p class="small muted">실제 토큰 수를 제공하지 않는 API는 ?로 표시됩니다. 실패·취소 직전 예약도 한도에 포함합니다.</p>`,
  );
}
async function safe(fn: () => unknown) {
  try {
    await fn();
  } catch (e) {
    toast((e as Error).message);
  }
}
document.addEventListener("click", (e) => {
  const t = (e.target as HTMLElement).closest<HTMLElement>("button");
  if (!t) return;
  void safe(async () => {
    if (t.dataset.room) {
      await selectRoom(t.dataset.room);
      return;
    }
    if (t.dataset.editAgent) {
      await editAgent(
        boot.agents.find((a: Agent) => a.id === t.dataset.editAgent),
      );
      return;
    }
    if (t.dataset.prompt) {
      $("#message").value = t.dataset.prompt;
      $("#message").focus();
      return;
    }
    if (t.dataset.mention) {
      addMention(t.dataset.mention);
      return;
    }
    if (t.dataset.unmention) {
      mentionIds.delete(t.dataset.unmention);
      t.remove();
      return;
    }
    if (t.dataset.member) {
      member(t.dataset.member);
      return;
    }
    if (t.dataset.invite) {
      const a = boot.agents.find((a: Agent) => a.id === t.dataset.invite);
      await api(`/rooms/${current}/members/${a.id}`, "PUT", {
        role: a.role,
        active: true,
      });
      close();
      await refreshRoom();
      return;
    }
    if (t.dataset.removeMember) {
      await api(
        `/rooms/${current}/members/${t.dataset.removeMember}`,
        "DELETE",
      );
      close();
      await refreshRoom();
      return;
    }
    if (t.dataset.deleteAgent) {
      if (!confirm("멤버를 삭제할까요? 기존 메시지는 보존됩니다.")) return;
      await api("/agents/" + t.dataset.deleteAgent, "DELETE");
      close();
      await refreshBoot();
      await refreshRoom();
      return;
    }
    if (t.dataset.testAgent) {
      close();
      await send(
        "parallel",
        [t.dataset.testAgent],
        "연결 테스트입니다. 자신의 이름과 역할을 한 문장으로 알려주세요.",
      );
      return;
    }
    switch (t.dataset.action) {
      case "connection":
        connection();
        break;
      case "close":
        close();
        break;
      case "logout":
        sessionStorage.removeItem("accessToken");
        sessionStorage.removeItem("apiBase");
        location.reload();
        break;
      case "theme":
        document.documentElement.classList.toggle("light");
        localStorage.setItem(
          "theme",
          document.documentElement.classList.contains("light")
            ? "light"
            : "dark",
        );
        break;
      case "mobile":
        document.body.classList.toggle("show-nav");
        break;
      case "new-room":
        await newRoom();
        break;
      case "new-agent":
        await editAgent();
        break;
      case "invite":
        await invite();
        break;
      case "send":
        await send();
        break;
      case "save-settings":
        await saveSettings();
        break;
      case "usage":
        await usage();
        break;
      case "resume":
        await refreshRoom();
        void pump();
        break;
      case "stop": {
        const r = data?.runs.find((r: any) =>
          ["running", "pending"].includes(r.status),
        );
        if (r) await api(`/runs/${r.id}/cancel`, "POST", {});
        await refreshRoom();
        break;
      }
      case "retry": {
        const r = data.runs[0];
        await send("parallel", undefined, r.goal, r.id);
        break;
      }
      case "start-discussion":
      case "start-autonomous":
        close();
        await send(
          t.dataset.action === "start-discussion" ? "discussion" : "autonomous",
          undefined,
          $("#message").value ||
            data.messages.filter((m: any) => m.kind === "user").at(-1)?.content,
        );
        break;
      case "settings-modal":
        settingsModal();
        break;
      case "room-menu":
        if (current)
          modal(
            "채팅방 관리",
            `${button("대화 설정", "settings-modal", "secondary")}${button("사용량", "usage", "secondary")}${button("토론 시작", "start-discussion", "secondary")}${button("자율 대화 시작", "start-autonomous", "secondary")}${button("이름 변경", "rename-room", "secondary")}${button("채팅방 삭제", "delete-room", "danger")}`,
          );
        break;
      case "rename-room": {
        const name = prompt("새 채팅방 이름", data.room.name);
        if (name) {
          await api("/rooms/" + current, "PATCH", { name });
          close();
          await refreshBoot();
          await refreshRoom();
        }
        break;
      }
      case "delete-room":
        if (
          confirm(
            "채팅방과 모든 대화·실행 기록을 삭제할까요? 사용량 기록은 유지됩니다.",
          )
        ) {
          await api("/rooms/" + current, "DELETE");
          current = "";
          data = null;
          close();
          await refreshBoot();
          if (boot.rooms.length) await selectRoom(boot.rooms[0].id);
          else {
            shell();
            renderNavigation();
            await refreshRoom();
          }
        }
        break;
    }
  });
});
if (localStorage.getItem("theme") === "light")
  document.documentElement.classList.add("light");
shell();
$("#timeline").innerHTML = empty();
renderNavigation();
if (base && token)
  void safe(async () => {
    await refreshBoot();
    if (boot.rooms.length) await selectRoom(boot.rooms[0].id);
  });

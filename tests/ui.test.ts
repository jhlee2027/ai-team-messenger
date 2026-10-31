import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { defaults } from "../worker/types";
test("UI loads persisted room, sanitizes Markdown, exposes mobile settings and saves without auto-call", async () => {
  const bundle = await build({
    entryPoints: ["src/main.ts"],
    bundle: true,
    write: false,
    format: "iife",
    loader: { ".css": "empty" },
  });
  const dom = new JSDOM(
    '<div id="app"></div><div id="toast"></div><dialog id="dialog"></dialog>',
    {
      url: "https://example.github.io/ai-team-messenger/",
      runScripts: "outside-only",
    },
  );
  const w = dom.window as any;
  const calls: string[] = [];
  const room = {
    id: "room",
    name: "기획실",
    settings: { ...defaults, autoReply: false },
  };
  const messages = [
    {
      id: "m",
      author: "AI",
      kind: "assistant",
      content:
        '**안전한 글** <img src=x onerror="alert(1)"><script>alert(1)</script>[위험](javascript:alert(1))',
      created_at: "2026-10-31",
      provider: "mock",
      model: "test-model",
    },
  ];
  w.sessionStorage.setItem("apiBase", "https://api.example");
  w.sessionStorage.setItem("accessToken", "x".repeat(64));
  w.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  w.fetch = async (url: string, init: any) => {
    const path = new URL(url).pathname;
    calls.push((init.method ?? "GET") + " " + path);
    if (path === "/api/bootstrap")
      return {
        ok: true,
        json: async () => ({ rooms: [room], agents: [], providers: [] }),
      };
    if (path.endsWith("/messages")) {
      messages.push({
        id: "u",
        author: "나",
        kind: "user",
        content: JSON.parse(init.body).content,
        created_at: "2026-10-31",
        provider: "",
        model: "",
      });
      return { ok: true, json: async () => ({ ok: true }) };
    }
    return {
      ok: true,
      json: async () => ({ room, messages, members: [], runs: [], tasks: [] }),
    };
  };
  try {
    w.eval(bundle.outputFiles[0].text);
    await new Promise((r) => setTimeout(r, 20));
    const d = w.document;
    assert.equal(d.querySelector("#room-name").textContent, "기획실");
    assert.equal(
      d.querySelectorAll(".markdown script,.markdown img,.markdown [onerror]")
        .length,
      0,
    );
    assert.ok(
      !d.querySelector(".markdown").innerHTML.includes('href="javascript:'),
    );
    assert.equal(d.querySelector(".markdown strong").textContent, "안전한 글");
    d.querySelector('[data-action="room-menu"]').click();
    d.querySelector('[data-action="settings-modal"]').click();
    assert.ok(d.querySelector('#settings-form [name="concurrency"]'));
    d.querySelector('[data-action="close"]').click();
    d.querySelector("#message").value = "자동 호출 없이 저장";
    d.querySelector('[data-action="send"]').click();
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(calls.includes("POST /api/rooms/room/messages"));
    assert.ok(!calls.some((c) => c.includes("/runs")));
    assert.ok(
      d.querySelector("#timeline").textContent.includes("자동 호출 없이 저장"),
    );
  } finally {
    w.close();
  }
});

// wrangler dev をローカルモードで起動し、偽の拡張機能 + MCP クライアントで一連の流れを確認する。
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const PORT = 8799, ADMIN = "admin-token", AGENT = "agent-token", BASE = `http://127.0.0.1:${PORT}`;
const dev = spawn("pnpm", ["exec", "wrangler", "dev", "--port", String(PORT), "--var", "ACCESS_TEAM_DOMAIN:", "--var", `LOCAL_ADMIN_TOKEN:${ADMIN}`, "--var", `LOCAL_AGENT_TOKENS:test=${AGENT}`, "--persist-to", mkdtempSync(join(tmpdir(), "tabgate-"))], { stdio: ["ignore", "pipe", "inherit"] });
await new Promise((ok) => dev.stdout.on("data", (d) => /Ready on/.test(d) && ok()));

try {
  const H = { authorization: `Bearer ${AGENT}`, "content-type": "application/json" };
  const api = (p, o = {}) => fetch(BASE + "/api" + p, { headers: { ...H, authorization: `Bearer ${ADMIN}` }, ...o });
  let n = 0;
  const mcp = async (method, params) => (await (await fetch(BASE + "/mcp", { method: "POST", headers: H, body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method, params }) })).json());
  const call = async (name, args = {}) => (await mcp("tools/call", { name, arguments: args })).result;

  assert.equal((await fetch(BASE + "/mcp", { method: "POST", body: "{}" })).status, 401, "認証なしは拒否");
  assert.equal((await fetch(BASE + "/api/state", { headers: H })).status, 403, "エージェントのトークンでは管理 API を使えない");
  assert.equal((await fetch(BASE + "/mcp", { method: "POST", headers: { ...H, origin: "https://evil.example" }, body: "{}" })).status, 403, "他サイトからは拒否");

  // ブラウザ登録
  const { id, token } = await (await api("/browsers", { method: "POST", body: JSON.stringify({ name: "test-chrome" }) })).json();

  // 不正トークンは切断される
  const bad = new WebSocket(`ws://127.0.0.1:${PORT}/ext`);
  await new Promise((ok) => (bad.onopen = ok));
  bad.send(JSON.stringify({ type: "hello", token: `${id}.wrong` }));
  assert.equal(await new Promise((ok) => (bad.onclose = (e) => ok(e.code))), 4001);

  // 偽の拡張機能
  const ext = new WebSocket(`ws://127.0.0.1:${PORT}/ext`);
  await new Promise((ok) => (ext.onopen = ok));
  ext.send(JSON.stringify({ type: "hello", token }));
  ext.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.method === "list_tabs") ext.send(JSON.stringify({ id: m.id, result: [{ tabId: 1, title: "Example", url: "https://example.com" }] }));
    if (m.method === "click") ext.send(JSON.stringify({ id: m.id, error: "not found" }));
  };
  await new Promise((r) => setTimeout(r, 200));

  assert.equal((await mcp("initialize", { protocolVersion: "2025-06-18" })).result.serverInfo.name, "tabgate");
  assert.ok((await mcp("tools/list")).result.tools.some((t) => t.name === "screenshot"));

  // 権限なし → エラー、エージェントとして記録される
  assert.equal((await call("list_tabs")).isError, true);
  const state = await (await api("/state")).json();
  assert.ok("local:test" in state.agents);
  assert.equal(state.browsers[0].online, true);

  // 権限付与 → 見える
  await api("/grants", { method: "PUT", body: JSON.stringify({ agent: "local:test", browsers: [id] }) });
  assert.match((await call("list_tabs")).content[0].text, /example\.com/);
  assert.equal((await call("click", { tabId: 1, selector: "#x" })).content[0].text, "not found");
  assert.match((await (await api(`/browsers/${id}/tabs`)).text()), /Example/);

  // ブラウザ削除 → 拡張機能は 4003 で切断
  const closed = new Promise((ok) => (ext.onclose = (e) => ok(e.code)));
  await api(`/browsers/${id}`, { method: "DELETE" });
  assert.equal(await closed, 4003);

  console.log("✅ e2e ok");
} finally {
  dev.kill();
}

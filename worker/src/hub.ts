import { DurableObject } from "cloudflare:workers";

type Browser = { id: string; name: string; tokenHash: string; createdAt: number };
type Grants = Record<string, string[]>; // agent -> browserId[]（"*" は全ブラウザ）
type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

const B = { browser: { type: "string", description: "ブラウザ ID か名前。許可されたブラウザが 1 台だけなら省略可" } };
const TAB = { tabId: { type: "number" } };
const tool = (name: string, description: string, props: Record<string, unknown> = {}, required: string[] = []) => ({
  name,
  description,
  inputSchema: { type: "object", properties: { ...B, ...props }, required },
});
const TOOLS = [
  tool("list_browsers", "このエージェントに許可されている Chrome の一覧"),
  tool("list_tabs", "タブ一覧"),
  tool("open_tab", "新しいタブを開く（バックグラウンド）", { url: { type: "string" } }, ["url"]),
  tool("navigate", "タブを URL に遷移させ読み込み完了を待つ", { ...TAB, url: { type: "string" } }, ["tabId", "url"]),
  tool("close_tab", "タブを閉じる", TAB, ["tabId"]),
  tool("screenshot", "タブのスクリーンショット（PNG）", TAB, ["tabId"]),
  tool(
    "read_page",
    "ページ本文。操作できる要素は本文中に [N]ラベル（入力欄は [N:type 値]）で埋め込まれ、selector `[data-tg=\"N\"]` で click / type に渡せる。query を渡すと Jev が関連する節だけを返す（トークン節約。拡張機能に Jev キー設定時のみ、未設定なら全文）",
    { ...TAB, query: { type: "string", description: "知りたいこと（例: 商品の価格）。英語の方が精度が高い" }, top_k: { type: "number", description: "返す節の数（既定 3）" } },
    ["tabId"],
  ),
  tool(
    "find",
    "自然文で操作対象の要素を探し、上位候補の selector と確率だけを返す（read_page で全要素を読むより大幅に少ないトークン）。exists が低いときは該当なしの可能性が高い。拡張機能に Jev キー設定時のみ",
    { ...TAB, query: { type: "string", description: "探す要素（例: login button）。英語の方が精度が高い" }, top_k: { type: "number", description: "返す候補数（既定 5）" } },
    ["tabId", "query"],
  ),
  tool("click", "CSS セレクタの要素をクリック", { ...TAB, selector: { type: "string" } }, ["tabId", "selector"]),
  tool("type", "要素にフォーカスして文字入力", { ...TAB, selector: { type: "string" }, text: { type: "string" }, submit: { type: "boolean", description: "最後に Enter を押す" } }, ["tabId", "selector", "text"]),
  tool(
    "port_forward",
    "ブラウザ側の PC から SSH 先への ssh -L ポート転送を開閉する。SSH 先で動かしている開発サーバーを open した後、open_tab で http://localhost:<port> を開ける。list で転送できるホスト（ブラウザ側 PC の ~/.ssh/config の名前）と開いている転送が分かる",
    { action: { type: "string", enum: ["open", "close", "list"] }, host: { type: "string", description: "SSH ホスト名（list の hosts から選ぶ）" }, port: { type: "number", description: "SSH 先の localhost のポート（1024〜65535）。ブラウザ側でも同じ番号で開く" } },
    ["action"],
  ),
  tool("evaluate", "ページで JavaScript 式を評価し結果を返す", { ...TAB, expression: { type: "string" } }, ["tabId", "expression"]),
  tool("cdp", "任意の Chrome DevTools Protocol コマンドを送る", { ...TAB, method: { type: "string" }, params: { type: "object" } }, ["tabId", "method"]),
];
const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

const sha256 = async (s: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
const text = (v: unknown) => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });

export class Hub extends DurableObject<Env> {
  pending = new Map<string, Pending>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // 拡張機能の keepalive は DO を起こさずに応答
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'));
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/ext") {
      // 未認証の接続は 10 秒で切り、同時に 100 本までに制限する（接続枠の枯渇対策）
      let pending = 0;
      for (const ws of this.ctx.getWebSockets()) {
        const a = ws.deserializeAttachment() as { browserId?: string; since: number };
        if (a.browserId) continue;
        if (Date.now() - a.since > 10_000) ws.close(4001, "hello timeout");
        else pending++;
      }
      if (pending >= 100) return new Response("too many pending connections", { status: 503 });
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ since: Date.now() });
      return new Response(null, { status: 101, webSocket: client });
    }
    const agent = req.headers.get("x-agent")!;
    if (url.pathname === "/mcp") return this.mcp(req, agent);
    return this.api(req, url, agent);
  }

  // ---------- 拡張機能との WebSocket ----------

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    let m: { type?: string; token?: string; id?: string; result?: unknown; error?: string };
    try {
      m = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return ws.close(4002, "bad json");
    }
    const att = ws.deserializeAttachment() as { browserId?: string };
    if (!att.browserId) {
      const b = m.type === "hello" && m.token ? await this.browserByToken(m.token) : null;
      if (!b) return ws.close(4001, "bad token");
      this.socketFor(b.id)?.close(4000, "replaced by new connection");
      ws.serializeAttachment({ browserId: b.id });
      ws.send(JSON.stringify({ type: "welcome", id: b.id, name: b.name }));
      return;
    }
    const p = m.id && this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id!);
    clearTimeout(p.timer);
    m.error ? p.reject(new Error(m.error)) : p.resolve(m.result);
  }

  async browserByToken(token: string) {
    const b = await this.ctx.storage.get<Browser>(`browser:${token.split(".")[0]}`);
    return b && b.tokenHash === (await sha256(token)) ? b : null;
  }

  socketFor(browserId: string) {
    return this.ctx.getWebSockets().find((ws) => (ws.deserializeAttachment() as { browserId?: string }).browserId === browserId);
  }

  call(browserId: string, method: string, params: unknown, timeoutMs = 60_000): Promise<unknown> {
    const ws = this.socketFor(browserId);
    if (!ws) return Promise.reject(new Error(`browser ${browserId} is offline`));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  // ---------- 権限 ----------

  async browsers() {
    return [...(await this.ctx.storage.list<Browser>({ prefix: "browser:" })).values()];
  }

  async allowed(agent: string) {
    const ids = (await this.ctx.storage.get<Grants>("grants"))?.[agent] ?? [];
    return (await this.browsers()).filter((b) => ids.includes("*") || ids.includes(b.id));
  }

  // ---------- MCP (Streamable HTTP, ステートレス・JSON 応答のみ) ----------

  async mcp(req: Request, agent: string): Promise<Response> {
    if (req.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
    const agents = (await this.ctx.storage.get<Record<string, number>>("agents")) ?? {};
    agents[agent] = Date.now(); // 管理画面で「見かけたエージェント」として権限付与できるように記録
    await this.ctx.storage.put("agents", agents);

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, { status: 400 });
    }
    const msgs = (Array.isArray(body) ? body : [body]) as { id?: string | number; method: string; params?: Record<string, unknown> }[];
    const out = (await Promise.all(msgs.map((m) => this.rpc(m, agent)))).filter(Boolean);
    if (!out.length) return new Response(null, { status: 202 });
    return Response.json(Array.isArray(body) ? out : out[0]);
  }

  async rpc(m: { id?: string | number; method: string; params?: Record<string, unknown> }, agent: string) {
    if (m.id === undefined) return null; // notification
    try {
      return { jsonrpc: "2.0", id: m.id, result: await this.method(m.method, m.params ?? {}, agent) };
    } catch (e) {
      return { jsonrpc: "2.0", id: m.id, error: { code: (e as { code?: number }).code ?? -32603, message: (e as Error).message } };
    }
  }

  async method(name: string, p: Record<string, unknown>, agent: string) {
    switch (name) {
      case "initialize":
        return {
          protocolVersion: p.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "tabgate", version: "0.1.0" },
          instructions: "list_browsers → list_tabs → read_page/screenshot → click/type の順で操作する。",
        };
      case "ping":
        return {};
      case "tools/list":
        return { tools: TOOLS };
      case "tools/call":
        return this.tool(p.name as string, (p.arguments ?? {}) as Record<string, unknown>, agent);
      default:
        throw Object.assign(new Error(`method not found: ${name}`), { code: -32601 });
    }
  }

  async tool(name: string, args: Record<string, unknown>, agent: string) {
    try {
      if (!TOOL_NAMES.has(name)) throw new Error(`unknown tool: ${name}`);
      const browsers = await this.allowed(agent);
      if (name === "list_browsers") return text(browsers.map((b) => ({ id: b.id, name: b.name, online: !!this.socketFor(b.id) })));
      const b = args.browser ? browsers.find((x) => x.id === args.browser || x.name === args.browser) : browsers.length === 1 ? browsers[0] : undefined;
      if (!b) throw new Error(browsers.length ? "`browser` を指定してください（list_browsers 参照）" : `${agent} に許可されたブラウザがありません。管理画面で権限を付与してください`);
      const r = await this.call(b.id, name, args);
      if (name === "screenshot") return { content: [{ type: "image", data: r, mimeType: "image/png" }] };
      return text(r ?? "ok");
    } catch (e) {
      return { ...text((e as Error).message), isError: true };
    }
  }

  // ---------- 管理 API（admin 判定は Worker 側で済んでいる） ----------

  async api(req: Request, url: URL, me: string): Promise<Response> {
    const [, , res, id, sub, tabId, act] = url.pathname.split("/");
    const s = this.ctx.storage;

    if (res === "state" && req.method === "GET") {
      return Response.json({
        me,
        browsers: (await this.browsers()).map(({ tokenHash, ...b }) => ({ ...b, online: !!this.socketFor(b.id) })),
        agents: (await s.get("agents")) ?? {},
        grants: (await s.get("grants")) ?? {},
      });
    }

    if (res === "browsers" && !id && req.method === "POST") {
      const { name } = (await req.json()) as { name?: string };
      if (!name) return new Response("name required", { status: 400 });
      const bid = crypto.randomUUID().slice(0, 8);
      const secret = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
      const token = `${bid}.${secret}`;
      await s.put(`browser:${bid}`, { id: bid, name, tokenHash: await sha256(token), createdAt: Date.now() } satisfies Browser);
      return Response.json({ id: bid, token }); // トークンはこの 1 回しか返さない
    }

    if (res === "browsers" && id && !sub && req.method === "DELETE") {
      await s.delete(`browser:${id}`);
      this.socketFor(id)?.close(4003, "revoked");
      const grants = (await s.get<Grants>("grants")) ?? {};
      for (const a in grants) grants[a] = grants[a].filter((x) => x !== id);
      await s.put("grants", grants);
      return new Response(null, { status: 204 });
    }

    try {
      if (res === "browsers" && id && sub === "tabs" && !tabId && req.method === "GET") return Response.json(await this.call(id, "list_tabs", {}));
      if (res === "browsers" && id && sub === "tabs" && act === "screenshot" && req.method === "GET") {
        const b64 = (await this.call(id, "screenshot", { tabId: Number(tabId) })) as string;
        return new Response(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)), { headers: { "content-type": "image/png" } });
      }
    } catch (e) {
      return new Response((e as Error).message, { status: 502 });
    }

    if (res === "grants" && req.method === "PUT") {
      const { agent, browsers } = (await req.json()) as { agent?: string; browsers?: string[] };
      if (!agent || !Array.isArray(browsers)) return new Response("agent and browsers required", { status: 400 });
      const grants = (await s.get<Grants>("grants")) ?? {};
      if (browsers.length) grants[agent] = browsers;
      else delete grants[agent];
      await s.put("grants", grants);
      return new Response(null, { status: 204 });
    }

    return new Response("not found", { status: 404 });
  }
}

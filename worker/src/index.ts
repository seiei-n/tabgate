import ADMIN_HTML from "./admin.html";
export { Hub } from "./hub";

export default {
  async fetch(req, env): Promise<Response> {
    const url = new URL(req.url);
    const hub = env.HUB.get(env.HUB.idFromName("global"));

    // 管理画面の HTML 自体はデータを含まない。データは /api で認証する。
    if (url.pathname === "/") return new Response(ADMIN_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });

    // 拡張機能の WebSocket。Access は Bypass にし、接続後の hello でブラウザトークンを検証する。
    if (url.pathname === "/ext") {
      if (req.headers.get("upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
      return hub.fetch(req);
    }

    // CSRF 対策: ブラウザ経由の他サイトからのリクエストを拒否（MCP 仕様でも Origin 検証は必須）。
    // CLI の MCP クライアントは Origin / Sec-Fetch-Site を送らないので影響しない。
    const origin = req.headers.get("origin");
    const site = req.headers.get("sec-fetch-site");
    if ((origin && origin !== url.origin) || (site && site !== "same-origin" && site !== "none")) {
      return new Response("cross-origin request rejected", { status: 403 });
    }

    const who = await identify(req, env);
    if (!who) return new Response("unauthorized", { status: 401 });
    const forward = () => {
      const h = new Headers(req.headers);
      h.set("x-agent", who); // DO は外部から直接叩けないので、ここで上書きした値だけが届く
      return hub.fetch(new Request(req, { headers: h }));
    };

    if (url.pathname === "/mcp") return forward();
    if (url.pathname.startsWith("/api/")) {
      const admins = env.ADMIN_EMAILS.split(",").map((s) => s.trim()).filter(Boolean);
      if (who !== "local-admin" && !admins.includes(who)) return new Response("forbidden", { status: 403 });
      return forward();
    }
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

/**
 * 呼び出し元の ID を返す。
 * Access モード: メール or "svc:<service token client id>"
 * ローカルモード: LOCAL_ADMIN_TOKEN → "local-admin"、LOCAL_AGENT_TOKENS（"name=token,..."）→ "local:<name>"
 */
async function identify(req: Request, env: Env): Promise<string | null> {
  if (env.ACCESS_TEAM_DOMAIN) {
    const jwt = req.headers.get("cf-access-jwt-assertion");
    const p = jwt && (await verifyAccessJwt(jwt, env.ACCESS_TEAM_DOMAIN, env.ACCESS_AUD.split(",").map((s) => s.trim())));
    if (!p) return null;
    return p.email ?? (p.common_name ? `svc:${p.common_name}` : null);
  }
  const { LOCAL_ADMIN_TOKEN, LOCAL_AGENT_TOKENS } = env as { LOCAL_ADMIN_TOKEN?: string; LOCAL_AGENT_TOKENS?: string };
  const bearer = req.headers.get("authorization")?.replace(/^Bearer /, "");
  if (!bearer) return null;
  if (LOCAL_ADMIN_TOKEN && bearer === LOCAL_ADMIN_TOKEN) return "local-admin";
  for (const pair of (LOCAL_AGENT_TOKENS ?? "").split(",")) {
    const [name, token] = pair.trim().split("=");
    if (name && token && bearer === token) return `local:${name}`;
  }
  return null;
}

type AccessPayload = { aud: string | string[]; exp: number; iss: string; email?: string; common_name?: string };
let jwks: JsonWebKey[] = [];

async function verifyAccessJwt(jwt: string, team: string, auds: string[]): Promise<AccessPayload | null> {
  const [h, p, s] = jwt.split(".");
  if (!s) return null;
  const dec = (x: string) => Uint8Array.from(atob(x.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  try {
    const header = JSON.parse(new TextDecoder().decode(dec(h))) as { kid: string; alg: string };
    const payload = JSON.parse(new TextDecoder().decode(dec(p))) as AccessPayload;
    if (header.alg !== "RS256") return null;
    if (payload.iss !== team.replace(/\/$/, "")) return null;
    if (payload.exp * 1000 < Date.now()) return null;
    if (![payload.aud].flat().some((a) => auds.includes(a))) return null;

    let jwk = jwks.find((k) => (k as { kid?: string }).kid === header.kid);
    if (!jwk) {
      // 鍵ローテーション時のみ再取得
      jwks = ((await (await fetch(`${team.replace(/\/$/, "")}/cdn-cgi/access/certs`)).json()) as { keys: JsonWebKey[] }).keys;
      jwk = jwks.find((k) => (k as { kid?: string }).kid === header.kid);
      if (!jwk) return null;
    }
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, dec(s), new TextEncoder().encode(`${h}.${p}`));
    return ok ? payload : null;
  } catch {
    return null;
  }
}

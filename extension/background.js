// サーバー（Worker の /ext）へ WebSocket で常時接続し、届いたコマンドをこの Chrome で実行する。
let ws = null;
let gen = 0; // connect() が並行して呼ばれたとき、古い試行を無効にする

async function connect() {
  const my = ++gen;
  ws?.close();
  ws = null;
  const { url, token, enabled } = await chrome.storage.local.get(["url", "token", "enabled"]);
  if (my !== gen) return;
  if (!enabled || !url || !token) return setStatus("停止中");
  const s = new WebSocket(url.replace(/^http/, "ws").replace(/\/$/, "") + "/ext");
  ws = s;
  setStatus("接続中…");
  s.onopen = () => (ws === s ? s.send(JSON.stringify({ type: "hello", token })) : s.close());
  s.onmessage = async (e) => {
    if (ws !== s) return s.close(); // 無効化された古い接続ではコマンドを実行しない
    const m = JSON.parse(e.data);
    if (m.type === "welcome") return setStatus(`接続済み: ${m.name}`);
    if (!m.id) return;
    const p = m.params ?? {};
    const run = () =>
      withTimeout((async () => (p.tabId != null && (await wake(p.tabId)), handlers[m.method](p)))(), 45_000, `${m.method} が 45 秒以内に終わりませんでした`);
    try {
      const result = await (p.tabId != null ? serial(p.tabId, run) : run());
      s.send(JSON.stringify({ id: m.id, result }));
    } catch (err) {
      s.send(JSON.stringify({ id: m.id, error: String(err?.message ?? err) }));
    }
  };
  s.onclose = (e) => {
    if (ws !== s) return;
    ws = null;
    setStatus(e.code === 4001 ? "トークンが無効です" : e.code === 4003 ? "サーバー側で削除されました" : "切断（再接続待ち）");
  };
}

function setStatus(status) {
  chrome.storage.session.set({ status });
  chrome.action.setBadgeText({ text: status.startsWith("接続済み") ? "" : "!" });
}

// keepalive: WebSocket の送受信があると MV3 service worker は停止しない（Chrome 116+）
setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send('{"type":"ping"}'), 20_000);
chrome.alarms.create("reconnect", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => !ws && connect());
chrome.storage.onChanged.addListener((ch, area) => area === "local" && ["url", "token", "enabled"].some((k) => k in ch) && connect());
connect();

// ---------- コマンド実装 ----------

// 同じタブへのコマンドは 1 つずつ実行する（focus → insertText の間に別の type が割り込まないように）
const queues = new Map();
function serial(tabId, fn) {
  const p = (queues.get(tabId) ?? Promise.resolve()).catch(() => {}).then(fn);
  queues.set(tabId, p);
  p.finally(() => queues.get(tabId) === p && queues.delete(tabId)).catch(() => {});
  return p;
}

// 止まったコマンドで serial の待ち行列が詰まらないよう、必ず期限内に終わらせる（Worker 側の 60 秒より短く）
function withTimeout(p, ms, msg) {
  let t;
  return Promise.race([p, new Promise((_, ng) => (t = setTimeout(() => ng(new Error(msg)), ms)))]).finally(() => clearTimeout(t));
}

const attached = new Set();
chrome.debugger.onDetach.addListener((src) => attached.delete(src.tabId));

async function cdp(tabId, method, params = {}) {
  if (!attached.has(tabId)) {
    await chrome.debugger.attach({ tabId }, "1.3").catch((e) => {
      if (!/already attached/i.test(e.message)) throw e;
    });
    attached.add(tabId);
    // 裏のウィンドウでもフォーカスがあるように振る舞わせる（focus / blur 依存の UI 対策）
    await chrome.debugger.sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  }
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

// 裏に置かれて眠ったタブを起こす。Memory Saver で破棄されていれば読み込み直し、凍結されていれば解除する
async function wake(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.autoDiscardable) await chrome.tabs.update(tabId, { autoDiscardable: false });
  if (tab.discarded) {
    await chrome.tabs.reload(tabId);
    await waitLoad(tabId);
  }
  await cdp(tabId, "Page.setWebLifecycleState", { state: "active" }).catch(() => {});
}

async function evaluate(tabId, expression) {
  const r = await cdp(tabId, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

const tabInfo = (t) => ({ tabId: t.id, windowId: t.windowId, active: t.active, title: t.title, url: t.url });

async function waitLoad(tabId) {
  for (let i = 0; i < 60; i++) {
    if ((await chrome.tabs.get(tabId)).status === "complete") return;
    await new Promise((r) => setTimeout(r, 250));
  }
}

const q = (selector) => `document.querySelector(${JSON.stringify(selector)})`;

// 仮想マウス: 操作する要素までカーソルを動かし、押したように縮ませる（人が見て追えるように）。
// innerHTML は Trusted Types のサイトで弾かれるので、CSS だけで描く
const moveCursor = `(async (e) => {
  const r = e.getBoundingClientRect(), x = r.left + r.width / 2 + 'px', y = r.top + r.height / 2 + 'px';
  let c = document.getElementById('__tg_cursor');
  if (!c) {
    c = document.createElement('div');
    c.id = '__tg_cursor';
    c.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;width:20px;height:20px;margin:-12px 0 0 -12px;border-radius:50%;'
      + 'background:rgba(255,90,0,.55);border:2px solid #fff;box-shadow:0 0 6px rgba(0,0,0,.5);transition:left .35s ease,top .35s ease,transform .15s;left:' + x + ';top:' + y;
    document.documentElement.appendChild(c);
  }
  c.style.left = x; c.style.top = y;
  if (!document.hidden) await new Promise((ok) => setTimeout(ok, 400)); // 見えないときは待たない（背景タブのタイマーは間引かれる）
  c.style.transform = 'scale(.6)';
  setTimeout(() => (c.style.transform = ''), 150);
})`;

// 操作できる要素に data-tg=N を振り、本文（要素の位置に [N] を埋め込んだもの）と、find 用の要素一覧（index = N）を返す。
// - 要素一覧: 同じ表記の要素が複数あれば（withContext 時のみ）、属する行・見出しのテキストを " @ ..." で添える
const readPage = (max, withContext = false) => `(() => {
  const one = (s) => s.replace(/\\s+/g, ' ').trim();
  document.querySelectorAll('[data-tg]').forEach((e) => e.removeAttribute('data-tg'));
  const els = [...document.querySelectorAll('a,button,input,textarea,select,[role=button],[role=link],[contenteditable=true],[onclick]')]
    .filter((e) => e.getClientRects().length).slice(0, ${max});
  const base = els.map((e) => '<' + e.tagName.toLowerCase() + (e.type ? ' type=' + e.type : '') + '> '
    + one(e.innerText || e.value || e.placeholder || e.getAttribute('aria-label') || e.getAttribute('href') || '').slice(0, 80));
  const count = {};
  base.forEach((b) => (count[b] = (count[b] || 0) + 1));
  const elements = els.map((e, i) => {
    e.setAttribute('data-tg', i);
    if (!${withContext} || count[base[i]] < 2) return base[i];
    // 行・項目を優先し、無ければ自分より多くのテキストを持つ最初の祖先
    let ctx = e.closest('tr,li,[role=row]');
    const own = one(e.innerText || '').length;
    if (!ctx) for (ctx = e.parentElement; ctx && one(ctx.innerText).length <= own + 5; ) ctx = ctx.parentElement;
    return ctx ? base[i] + ' @ ' + one(ctx.innerText).slice(0, 60) : base[i];
  });

  // 本文: 操作できる要素の位置に [N] を埋め込む（要素一覧を別に返さないので重複しない）。
  // ブロック要素ごとに改行し、表の行・リスト項目・見出しは中身ごと 1 行にまとめる。
  const tg = new Map(els.map((e, i) => [e, i]));
  const out = [];
  let line = '', rowDepth = 0;
  const flush = () => { const t = one(line); if (t) out.push(t); line = ''; };
  const visit = (n) => {
    if (n.nodeType === 3) { line += n.textContent; return; }
    if (n.nodeType !== 1 || ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'svg'].includes(n.tagName)) return;
    const d = getComputedStyle(n).display;
    if (d === 'none' || (d !== 'contents' && !n.checkVisibility())) return;
    if (n.tagName === 'BR') { rowDepth ? (line += ' ') : flush(); return; }
    const block = !d.startsWith('inline') && d !== 'contents';
    const row = n.matches('tr,li,[role=row],h1,h2,h3,h4,h5,h6');
    if ((block || row) && !rowDepth) flush(); else if (block) line += ' ';
    if (row) rowDepth++;
    const i = tg.get(n);
    if (i === undefined) n.childNodes.forEach(visit);
    else if (['INPUT', 'TEXTAREA', 'SELECT'].includes(n.tagName)) {
      const v = n.tagName === 'SELECT' ? n.selectedOptions[0]?.text : n.value || n.placeholder;
      line += ' [' + i + ':' + n.type + ' ' + one(v || n.getAttribute('aria-label') || '').slice(0, 60) + '] ';
    } else {
      const t = one(n.innerText || '');
      // 中身の長いリンク（カード全体など）は印だけ付けて中身は本文として読む
      if (t.length > 80) { line += ' [' + i + '] '; n.childNodes.forEach(visit); }
      else line += ' [' + i + ']' + (t || n.getAttribute('aria-label') || n.title || '') + ' ';
    }
    if (row) rowDepth--;
    if ((block || row) && !rowDepth) flush();
  };
  visit(document.body);
  flush();
  return { url: location.href, title: document.title, text: out.join('\\n').slice(0, 30000), elements };
})()`;

// ---------- Jev（TypeSafe）: ページを拡張機能側で絞り込み、エージェントに渡すトークンを減らす ----------
// API キーは拡張機能の中だけに置く（Worker やエージェントには渡さない）。

const JEV_OPTIONS = 250; // Choice の option 上限は 255。"none" の分を空けておく
const round = (p) => Math.round(p * 100) / 100;
const top = (entries, k) => entries.sort((a, b) => b[1] - a[1]).slice(0, k);

async function jev(state, questions) {
  const { jevKey } = await chrome.storage.local.get("jevKey");
  if (!jevKey) throw new Error("Jev の API キーが未設定です（拡張機能のポップアップで設定）");
  for (let i = 0; ; i++) {
    const r = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: { authorization: `Bearer ${jevKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "jev-latest", state, questions }),
    });
    if ((r.status === 429 || r.status === 529) && i < 3) {
      await new Promise((ok) => setTimeout(ok, (Number(r.headers.get("retry-after")) || 2 ** i) * 1000));
      continue;
    }
    if (!r.ok) throw new Error(`Jev ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return (await r.json()).answers;
  }
}

/**
 * state 内の id 付きリストから、question に最も合うものを選ぶ（semantic find パターン）。
 * - 「そもそも該当があるか」の Noul を同時に聞く（Choice は該当なしでも必ずどれかを 1 位にするため）
 * - 250 件を超えたら区切って並列に Choice → 各区切りの上位で決勝（区切りをまたいだ確率は比較できないため）
 */
async function jevPick({ state, ids, question, existsQuestion, topK }) {
  const choice = (opts) => ({ type: "choice", instructions: question, criteria: Object.fromEntries([...opts.map((id) => [id, null]), ["none", "Nothing in the list matches"]]) });
  const chunks = [];
  for (let i = 0; i < ids.length; i += JEV_OPTIONS) chunks.push(ids.slice(i, i + JEV_OPTIONS));
  const a = await jev(state, { exists: { type: "noul", instructions: existsQuestion }, ...Object.fromEntries(chunks.map((c, i) => [`c${i}`, choice(c)])) });
  const ranked = (ans) => Object.entries(ans.probabilities).filter(([k]) => k !== "none");
  let result = ranked(a.c0);
  if (chunks.length > 1) {
    const finalists = chunks.flatMap((_, i) => top(ranked(a[`c${i}`]), topK)).map(([k]) => k);
    result = ranked((await jev(state, { final: choice(finalists) })).final);
  }
  // 確率がほぼ 0 の候補は返さない（トークン節約）。最低 1 件は残す
  const best = top(result, topK).map(([id, p]) => [id, round(p)]);
  return { exists: round(a.exists.noul), ranked: best.filter(([, p], i) => i === 0 || p >= 0.05) };
}

// 本文を行単位でまとめて size 文字程度の節にする
function passages(text, size = 500) {
  const out = [];
  let cur = "";
  // 1 行（表の行など）は途中で切らない。極端に長い行だけ 2,000 字で打ち切る
  for (const line of text.split("\n").map((l) => l.trim().slice(0, 2000)).filter(Boolean)) {
    if (cur && cur.length + line.length > size) out.push(cur), (cur = "");
    cur += (cur ? "\n" : "") + line;
  }
  if (cur) out.push(cur);
  return out;
}

const handlers = {
  list_tabs: async () => (await chrome.tabs.query({})).map(tabInfo),
  open_tab: async ({ url }) => tabInfo(await chrome.tabs.create({ url, active: false })),
  navigate: async ({ tabId, url }) => {
    await chrome.tabs.update(tabId, { url });
    await waitLoad(tabId);
    return tabInfo(await chrome.tabs.get(tabId));
  },
  close_tab: async ({ tabId }) => (await chrome.tabs.remove(tabId), "closed"),
  // 背景タブは描画されず撮影が返ってこない。今の寸法で metrics を上書きすると描画される。
  // それでも返らない（隠れたウィンドウ等）ときは長く待たずに理由を返す
  screenshot: async ({ tabId }) => {
    const [w, h, dpr] = await evaluate(tabId, "[innerWidth, innerHeight, devicePixelRatio]");
    await cdp(tabId, "Emulation.setDeviceMetricsOverride", { width: w || 1280, height: h || 800, deviceScaleFactor: dpr || 1, mobile: false });
    try {
      return (await withTimeout(cdp(tabId, "Page.captureScreenshot", { format: "png" }), 10_000,
        "描画されていないため撮影できません（隠れたウィンドウの可能性）。read_page を使うか、ウィンドウを表示してください")).data;
    } finally {
      await cdp(tabId, "Emulation.clearDeviceMetricsOverride").catch(() => {});
    }
  },
  read_page: async ({ tabId, query, top_k = 3 }) => {
    const page = await evaluate(tabId, readPage(300));
    const full = { url: page.url, title: page.title, text: page.text };
    if (!query) return full;
    if (!(await chrome.storage.local.get("jevKey")).jevKey) return { ...full, note: "Jev の API キーが未設定のため query を無視して全文を返しました" };
    // ponytail: Jev は state + 質問で 32k tokens まで。本文は先頭 20,000 字で打ち切る。長いページは節ごとの 2 段階選抜が必要になったら入れる
    const ps = passages(page.text.slice(0, 20000));
    const r = await jevPick({
      state: { goal: query, page: { title: page.title, url: page.url }, passages: ps.map((t, i) => `p${i}| ${t}`) },
      ids: ps.map((_, i) => `p${i}`),
      question: "Which entry in `passages` is most relevant to `goal`? Each option is a passage id.",
      existsQuestion: "Does any entry in `passages` contain information relevant to `goal`?",
      topK: top_k,
    });
    return { url: page.url, title: page.title, relevant: r.exists, passages: r.ranked.map(([id, p]) => ({ p, text: ps[Number(id.slice(1))] })) };
  },
  find: async ({ tabId, query, top_k = 5 }) => {
    // ponytail: 要素は 500 件まで（state が 32k tokens に収まる目安）
    const page = await evaluate(tabId, readPage(500, true));
    if (!page.elements.length) return { exists: 0, candidates: [] };
    const r = await jevPick({
      state: { goal: query, page: { title: page.title, url: page.url }, elements: page.elements.map((l, i) => `e${i}| ${l}`) },
      ids: page.elements.map((_, i) => `e${i}`),
      question: "Which entry in `elements` is the interactive element that best matches `goal`? Each option is an element id.",
      existsQuestion: "Does any entry in `elements` match `goal`?",
      topK: top_k,
    });
    const n = (id) => Number(id.slice(1));
    return { exists: r.exists, candidates: r.ranked.map(([id, p]) => ({ selector: `[data-tg="${n(id)}"]`, element: page.elements[n(id)], p })) };
  },
  evaluate: ({ tabId, expression }) => evaluate(tabId, expression),
  click: ({ tabId, selector }) =>
    evaluate(tabId, `(async () => { const e = ${q(selector)}; if (!e) throw new Error('not found'); e.scrollIntoView({ block: 'center' }); await ${moveCursor}(e); e.click(); return 'clicked'; })()`),
  type: async ({ tabId, selector, text, submit }) => {
    await evaluate(tabId, `(async () => { const e = ${q(selector)}; if (!e) throw new Error('not found'); e.scrollIntoView({ block: 'center' }); await ${moveCursor}(e); e.focus(); })()`);
    await cdp(tabId, "Input.insertText", { text });
    if (submit) {
      const key = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 };
      await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyDown", text: "\r", ...key });
      await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...key });
    }
    return "typed";
  },
  cdp: ({ tabId, method, params }) => cdp(tabId, method, params),
  // この PC から SSH 先への ssh -L を、Mac に入れた native messaging host（native/）経由で開閉する
  port_forward: ({ action, host, port }) =>
    new Promise((ok, ng) =>
      chrome.runtime.sendNativeMessage("com.tabgate.forward", { op: action, host, port }, (r) => {
        if (chrome.runtime.lastError) return ng(new Error(`${chrome.runtime.lastError.message}（ブラウザ側の PC で native/install.sh を実行したか確認）`));
        r.ok ? ok(r.result) : ng(new Error(r.error));
      }),
    ),
};

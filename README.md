# tabgate

English | [日本語](README.ja.md)

A bridge that lets any coding harness (Claude Code, Codex, Cursor, or any other MCP client) drive your own Chrome.
It relays through Cloudflare Workers and authenticates with Cloudflare Access (Zero Trust), so agents behind NAT, such as ones running on a remote host over SSH, can reach your local browser too.

```
[Agent (e.g. on an SSH host)] --MCP/HTTP--> [Cloudflare Access] --> [Worker /mcp] ─┐
[Admin's browser] ------------------------> [Cloudflare Access] --> [Worker / , /api] ├─ Durable Object "Hub"
[Chrome extension] ------WebSocket-------> (Access Bypass)    --> [Worker /ext] ──┘   (browsers, grants, relay)
```

- `extension/`: Chrome extension (MV3). Keeps a WebSocket open to the Worker and drives tabs through `chrome.debugger` (CDP).
- `worker/`: Cloudflare Worker + Durable Object. One deployment serves the MCP server (Streamable HTTP), the extension relay, and the admin UI.

The admin UI and extension popup are currently in Japanese.

## Access model

- **Browsers**: registering a browser in the admin UI issues a token; the extension connects with that token.
- **Agents**: identified by the identity Access attaches (an email for users, `svc:<Client ID>` for service tokens).
- **Grants**: in the admin UI, tick which agents may see which browsers. Nothing is visible by default.
- Unticking "allow connections from agents" in the extension popup disconnects immediately.

## MCP tools

`list_browsers` `list_tabs` `open_tab` `navigate` `close_tab` `screenshot` `read_page` `find` `port_forward` `click` `type` `evaluate` `cdp`

If an agent is granted exactly one browser, the `browser` argument can be omitted.

`read_page` returns the page text with markers embedded where interactive elements are. Pass a marker's number to `click` / `type` as `[data-tg="N"]`. Each table row, list item, and heading is collapsed onto one line.

```
alice@example.com Alice [53:select-one member] [54]Save Last login 2026/06/29 … [56]Resend invite [57]Suspend [58]Delete
```

- `[N]label`: links, buttons, etc.
- `[N:type value]`: form fields (the placeholder when the value is empty)

## Open dev servers on an SSH host in your browser (optional, macOS)

An agent on an SSH host can open the dev server it runs on, say, `localhost:5173` in your local Chrome and interact with it. The browser machine opens an `ssh -L` port forward, so nothing extra is needed on the SSH host or on Cloudflare.

### Setup (once, on the Mac running the browser)

```sh
./native/install.sh <extension ID>     # shown for tabgate on chrome://extensions
echo devbox >> ~/.config/tabgate/forward-hosts   # SSH hosts allowed for forwarding (names from ~/.ssh/config)
```

Requires passwordless `ssh <host>` from that Mac.

### Usage (by the agent)

1. `port_forward` `{ "action": "list" }` to see which hosts can be forwarded
2. `port_forward` `{ "action": "open", "host": "devbox", "port": 5173 }` to open the forward
3. `open_tab` on `http://localhost:5173`, then use `read_page` / `click` etc. as usual
4. `port_forward` `{ "action": "close", ... }` when done

### How it works and limits

- The extension launches `native/tabgate-forward.py` via Chrome native messaging, which runs `ssh -f -N -L 127.0.0.1:<port>:localhost:<port> <host>`.
- Only hosts listed in `~/.config/tabgate/forward-hosts` can be forwarded. Ports must be integers from 1024 to 65535, and forwards listen on the Mac's `127.0.0.1` only (not visible on the LAN).
- The same port number is used on both sides. `open` fails if the port is already taken on the Mac.
- Works only in Chrome on the machine where the native host is installed.
- Input validation test: `python3 native/test_forward.py`

## Save tokens with Jev (optional)

With [TypeSafe](https://typesafe.ai)'s Jev, the extension selects just the relevant part of a page instead of handing the whole page to the agent.

### Setup

1. Create an API key at [console.typesafe.ai](https://console.typesafe.ai/keys)
2. Paste it into the "Jev API キー" (Jev API key) field in the extension popup and save

The key is stored only inside the extension (`chrome.storage.local`) and is never sent to the Worker or to agents. The extension calls Jev directly.

### What it enables

| Tool | Input | Output |
|---|---|---|
| `find` | `query`: the element to look for (e.g. `login button`), `top_k` (default 5) | candidate selectors, element labels, probability `p`, and `exists`, the probability that anything matches |
| `read_page` + `query` | `query`: what you want to know (e.g. `price of the product`), `top_k` (default 3) | only the relevant passages, plus `relevant`, the probability that anything relevant exists |

The `selector` returned by `find` can be passed straight to `click` / `type`.

```jsonc
// find { "tabId": 123, "query": "delete button for alice@example.com" }
{
  "exists": 0.9,
  "candidates": [
    { "selector": "[data-tg=\"58\"]", "element": "<button type=submit> Delete @ alice@example.com Alice member Save Last login…", "p": 0.99 }
  ]
}
```

### Guidance for agents

- On large pages (tens of thousands of characters), narrow down with `find` / `read_page` + `query`. On small pages, a single full `read_page` is cheaper (see the measurements below).
- Write `query` in English (Jev is more accurate in English).
- Before irreversible actions such as deleting, check the candidate's `element` (row context follows the `@`).

Measured on an admin page listing 22 OAuth clients:

- Size of one response: full `read_page` 4,635 chars (8,234 before markers were embedded in the text), `find` 155–224 chars, `read_page` + `query` 604 chars. About 0.45 s per call, including the Worker, extension, and Jev round trips.
- Whole task (the same read-only tasks run 3 times each in Claude Code, with and without Jev): on a page this size, Jev did not reduce total tokens. One extra tool call makes the agent resend the whole conversation (about 16k tokens), which outweighs what skipping the full text saves.

Measured on the English Wikipedia article "Tokyo" (large enough that full `read_page` is cut off at 30,000 chars):

- Input tokens for the whole task: 27,245 without Jev vs 15,900–16,700 with Jev (about 40% less). Similar for both a fact-finding task and a find-the-selector task. All 18 runs answered correctly.
- On this large page, the agent passed `query` to `read_page` on its own without being told to.

### How it works

- IDs are assigned to the element list or text passages, and Jev is asked in a single request both which one fits (Choice) and whether anything fits at all (Noul).
- Beyond 250 elements, chunks of 250 are ranked in parallel and the top picks of each chunk go to a final round (Choice allows at most 255 options).
- Elements with identical labels (such as a "Delete" button on every row) get their row or section text appended so they can be told apart.
- Page text is collapsed to one line per table row, list item, and heading, then split into passages of about 500 chars.
- Candidates with probability below 0.05 are dropped (at least one is always returned).

### Caveats

- Using `find` or `read_page` + `query` sends the page's element list and text to the TypeSafe API. Don't use them on pages that must not leave your organization (clear the key and nothing is sent).
- Without a key, `find` returns an error and `read_page` ignores `query` and returns the full text.
- `find` looks at up to 500 elements and `read_page` + `query` at the first 20,000 chars of text (to fit Jev's 32k-token input limit).

## Run locally (LAN)

```sh
cd worker
pnpm install
cat > .dev.vars <<'EOF'
ACCESS_TEAM_DOMAIN=
LOCAL_ADMIN_TOKEN=a-long-random-string-for-the-admin-ui
LOCAL_AGENT_TOKENS=laptop=a-long-random-string-for-an-agent,server=another-token
EOF
pnpm dev               # listens on 0.0.0.0:8787
```

With `ACCESS_TEAM_DOMAIN` empty, tabgate runs in local mode and authenticates with bearer tokens (`.dev.vars` overrides the production settings in `wrangler.jsonc`).

- `LOCAL_ADMIN_TOKEN`: for the admin UI and admin API. Never give it to agents.
- `LOCAL_AGENT_TOKENS`: for agents, as comma-separated `name=token` pairs. Agents are identified as `local:<name>` and see only the browsers granted to them.

1. Open `http://<IP>:8787/`, enter the LOCAL_ADMIN_TOKEN, register a browser, and copy its token
2. On `chrome://extensions`, use "Load unpacked" to load `extension/`
3. In the extension popup, enter the server URL and the token, tick "allow", and save
4. Register the server with your agent:

```sh
claude mcp add --transport http tabgate http://<IP>:8787/mcp --header "Authorization: Bearer <agent token>"
```

5. In the admin UI, grant the browser to agent `local:<name>`

## Deploy to Cloudflare for remote use

```sh
cd worker
pnpm run deploy
```

Assign a custom domain (e.g. `tabgate.example.com`) to the Worker, then configure the following in the Zero Trust dashboard.

1. **Access application (main)**: self-hosted, domain `tabgate.example.com`
   - Policy: Allow the emails / groups of the people who will use it
   - For environments without a browser (such as SSH hosts), create a service token and add a **Service Auth** policy
   - Advanced settings → turn on **Managed OAuth** (lets MCP clients log in via OAuth)
   - Note the **Application Audience (AUD) Tag**
2. **Access application (extension)**: self-hosted, domain `tabgate.example.com`, path `/ext`, policy **Bypass**
   (the extension sends its browser token in the WebSocket hello, and the Worker verifies it)
3. Set `vars` in `wrangler.jsonc` and redeploy:
   - `ACCESS_TEAM_DOMAIN`: `https://<team>.cloudflareaccess.com`
   - `ACCESS_AUD`: the AUD from step 1
   - `ADMIN_EMAILS`: emails allowed to use the admin UI

Connecting from an agent:

```sh
# Where you can log in with a browser (Managed OAuth)
claude mcp add --transport http tabgate https://tabgate.example.com/mcp

# On SSH hosts etc. (service token)
claude mcp add --transport http tabgate https://tabgate.example.com/mcp \
  --header "CF-Access-Client-Id: <id>" --header "CF-Access-Client-Secret: <secret>"
```

The agent shows up in the admin UI after its first connection; tick the browsers it should see.

## Tests

```sh
cd worker && pnpm test  # starts wrangler dev and exercises everything with a fake extension + MCP client
```

## Known limitations

- `screenshot` may time out on background tabs
- Tabs being driven show Chrome's "is debugging this browser" bar (a `chrome.debugger` requirement)
- MCP responses are JSON only (no SSE streaming or server-initiated notifications)
- The relay is a single Durable Object instance, aimed at individuals and small teams

## License

[MIT](LICENSE)

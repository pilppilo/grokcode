# grokcode

Drive [OpenCode](https://opencode.ai) on your own computers from a remote MCP client such as Grok Bot. Each PC runs a small agent next to `opencode serve`. Grok Bot never dials those PCs directly unless you want it to.

Two transports, both first-class. Neither one imports or requires the other.

| Mode | Who listens | How the PC is reached |
| --- | --- | --- |
| **Cloudflare relay (default)** | A Worker you deploy | The agent dials **out** over WebSocket. No open ports, no Tailscale. |
| **Direct** | The agent itself | You reach it over Tailscale (tailnet or Funnel) or any other network. No Cloudflare account. |

```text
Grok Bot  --HTTPS + bearer-->  Cloudflare Worker  --WebSocket--  agent on a PC  -->  opencode serve
Grok Bot  --HTTPS + bearer-->  agent on a PC (Tailscale/Funnel/LAN)  -->  opencode serve
```

The MCP tool list is the same in both modes.

## OpenCode API this talks to

Checked against the current OpenCode docs, not the older route table alone.

* **v2 (what `opencode serve` speaks today, including the 2.2 line).** HTTP API under `/api`, OpenAPI UI at `/doc`. Basic auth username is always `opencode`. Set `OPENCODE_PASSWORD` to choose the password; otherwise `opencode serve` prints a generated one (`server password …`). See [Web](https://opencode.ai/docs/cli/web/) and the [HTTP API](https://opencode.ai/docs/api/).
  * Create a session with `POST /api/session` and `location.directory` (absolute path).
  * `POST /api/session/:id/prompt` **admits** the prompt and schedules the agent loop. It does not block until the model finishes, and there is no v2 `prompt_async`.
  * Activity comes from `GET /api/session/active` (sessions absent from that map are idle).
  * Stop a turn with `POST /api/session/:id/interrupt`.
  * Permissions: `GET /api/permission/request` or `GET /api/session/:id/permission`, then `POST /api/session/:id/permission/:requestId/reply` with `decision` of `once`, `always`, or `reject`.
  * Diff: `GET /api/session/:id/diff`. Events: `GET /api/event` (SSE). This bridge polls instead of holding that stream open, because a remote MCP call and a Cloudflare request both time out long before a coding turn finishes.
* **v1 fallback.** If `/api/info` is not a JSON API, the agent uses the [v1 server routes](https://opencode.ai/docs/server/): `POST /session/:id/prompt_async`, `POST /session/:id/abort`, `POST /session/:id/permissions/:id` (and `/permission/:id/reply` if that 404s), `GET /session/status`, `GET /global/health`. Password env `OPENCODE_SERVER_PASSWORD` is also accepted. On a v2 server those unprefixed paths are the web UI and return HTML; the client treats HTML as "not this API" and does not pretend it succeeded.

`opencode serve --port 4096` is still the foreground server. OpenCode also has a per-user background service (`opencode service`, often port 49374 on macOS/Linux and 28894 on Windows). Point the agent at whichever one you want with `--opencode-url`.

## Tools

Every tool except `list_machines` accepts `machine`. In direct mode it defaults to the local machine. In relay mode it defaults only when exactly one machine is online.

| Tool | What it does |
| --- | --- |
| `list_machines` | PCs currently connected. |
| `server_info` | Health, API generation, version. |
| `list_projects` / `list_sessions` | Projects and sessions. |
| `start_session` | New session. `directory` must be absolute. Optional `agent`, `model` (`provider/model`). |
| `send_prompt` | Admit a prompt. `wait` defaults to **false**. `wait: true` polls until idle, a permission is pending, or ~20s. |
| `wait_session` | Same poll, without sending another prompt. |
| `get_session` / `get_messages` | Status (`idle`, `busy`, `retry`) and transcript text. |
| `get_diff` | Session or turn diff. |
| `list_pending_permissions` / `respond_permission` | `approve`/`once`, `always`, `deny`/`reject`. |
| `abort` | Interrupt the current turn. |
| `list_agents` / `list_models` | What that server can run. |
| `run_command` | Slash command. |
| `list_forms` / `reply_form` | v2 forms, or the v1 question tool. |
| `delete_session` | Delete a session and its children. |

If a wait hits the budget the tool returns `status: "running"` and you poll `get_session` / `get_messages` or call `wait_session` again. Pending permissions come back as `status: "needs_permission"` so you can answer them instead of waiting out the clock.

The relay forwards **named operations only**. It is not an open HTTP proxy to the PC.

## Security

This repository is public. Do not commit tokens, `.dev.vars`, real worker hostnames, or account ids.

* **MCP client token** (`MCP_TOKEN` on the Worker, `GROKCODE_MCP_TOKEN` on a direct agent). Grok Bot sends `Authorization: Bearer …`.
* **Per-machine token** (`MACHINE_TOKENS` on the Worker, `GROKCODE_MACHINE_TOKEN` on that PC). The relay checks the bearer token against the name in `X-Grokcode-Machine`. One machine's token does not authenticate as another.
* Tokens shorter than 16 characters are rejected. Comparisons are constant-time. Parse errors for `MACHINE_TOKENS` do not echo the secret.
* **Directory allowlist** (`--allow-dir` / `GROKCODE_ALLOW_DIRS`). When set, session create and any later call are refused unless that session's directory is the allowed directory or a child of it. Prefix tricks (`/src` vs `/src-evil`) do not pass. An empty allowlist means any absolute path.
* Direct mode rejects browser `Origin` values that are not the request host or loopback, so a website cannot use DNS rebinding against the local port. The relay is bearer-authenticated and is not a cookie session.
* Spawned `opencode serve` binds to `127.0.0.1` by default. The agent scrapes a generated password from stdout and does not log it.

Provider logins stay in your normal OpenCode config on that PC. This project never sees them.

## Deploy the Cloudflare relay

Requirements: [Node 20+](https://nodejs.org/) and a Cloudflare account. From a clone of this repo:

```bash
npm install
npm run build
cd packages/relay-worker
npx wrangler login
npx wrangler secret put MCP_TOKEN
npx wrangler secret put MACHINE_TOKENS
npx wrangler deploy
```

`MCP_TOKEN` is one long random string (the Grok Bot bearer token).

`MACHINE_TOKENS` is a JSON object, one entry per PC. Generate each value locally:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

```json
{"laptop":"<token-for-laptop>","desktop":"<token-for-desktop>"}
```

Wrangler prints the worker URL, `https://<name>.<account>.workers.dev`. The MCP endpoint is that origin plus `/mcp`. The agent WebSocket is the same origin plus `/agent`. Nothing in the repo should be edited to store that hostname.

Local dry run, with secrets in a gitignored `.dev.vars` copied from `.dev.vars.example`:

```bash
npx wrangler dev
```

`packages/relay-worker/wrangler.toml` has no account id. `nodejs_compat` is on because token comparison uses `node:crypto`.

## Add it to Grok Bot

In the Grok Bot MCP connector settings:

| Field | Value |
| --- | --- |
| URL | `https://<your-worker-host>/mcp` |
| Header | `Authorization` |
| Value | `Bearer <MCP_TOKEN>` |

The server speaks [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports) (protocol versions `2025-03-26`, `2025-06-18`, `2025-11-25`, and `2024-11-05`). POST responses are a single JSON-RPC body, which is what a remote connector that only stores a URL and a bearer header needs. A session id is not required. `GET /mcp` is a keepalive SSE stream for clients that open one. `DELETE /mcp` returns 204.

`GET /health` is unauthenticated and does not list machines.

## Install the agent on a PC

Install OpenCode first (`opencode upgrade` / the [install script](https://opencode.ai)) and log in to a model provider in the normal way. Then, from this repo:

```bash
npm install
npm run build
```

`npx grokcode-agent --help` works after that build. You can also install the built package onto the machine:

```bash
npm install -g ./packages/agent
grokcode-agent --help
```

Relay only (the usual setup). The agent starts `opencode serve` on `127.0.0.1:4096` if nothing is already healthy there, then keeps the WebSocket up:

```bash
export GROKCODE_MACHINE_TOKEN='<the laptop token from MACHINE_TOKENS>'
export OPENCODE_PASSWORD='<a long password>'
grokcode-agent --name laptop --relay wss://<your-worker-host>/agent
```

Attach to a server you already started (including `opencode service`) instead of spawning one:

```bash
grokcode-agent --name laptop \
  --relay wss://<your-worker-host>/agent \
  --opencode-url http://127.0.0.1:4096 \
  --no-spawn
```

Useful flags: `--allow-dir ~/src` (repeatable), `--opencode-bin`, `--opencode-port`, `--verbose`, `--config deploy/agent.example.json`. A copy-paste env file lives at `deploy/agent.example.env`. CLI flags win over the environment, which wins over the config file. Do not put tokens in the JSON config; the loader never reads a token field from it.

The process reconnects with backoff (1s, 2s, … up to 30s) if the relay drops. If it spawned OpenCode, it restarts that process after a crash. `SIGINT` / `SIGTERM` stop both.

### Linux (systemd user service)

```bash
npm install -g /path/to/grokcode/packages/agent
mkdir -p ~/.config/grokcode ~/.config/systemd/user ~/.local/bin
cp deploy/agent.example.env ~/.config/grokcode/agent.env
# edit ~/.config/grokcode/agent.env
ln -sf "$(command -v grokcode-agent)" ~/.local/bin/grokcode-agent
cp deploy/grokcode-agent.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now grokcode-agent
loginctl enable-linger "$USER"
journalctl --user -u grokcode-agent -f
```

### macOS (launchd)

Copy `deploy/com.grokcode.agent.plist` to `~/Library/LaunchAgents/`. The template expects `grokcode-agent` on `/usr/local/bin` and contains placeholder token strings; edit those on the machine, then:

```bash
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.grokcode.agent.plist
launchctl enable gui/$UID/com.grokcode.agent
launchctl kickstart -k gui/$UID/com.grokcode.agent
```

Logs: `/tmp/grokcode-agent.log`. Prefer storing tokens in the plist only on that Mac, or wrap the binary in a shell script that `source`s `~/.config/grokcode/agent.env` if you do not want them in the plist.

### Windows (Task Scheduler)

In PowerShell, after `npm install -g`:

```powershell
mkdir $env:USERPROFILE\.config\grokcode -Force
copy deploy\agent.example.env $env:USERPROFILE\.config\grokcode\agent.env
# edit agent.env
powershell -ExecutionPolicy Bypass -File deploy\install-windows-task.ps1
Start-ScheduledTask -TaskName GrokcodeAgent
```

The task runs at logon and restarts on failure. `opencode serve` is started by the agent with `shell` on Windows so the `opencode.cmd` shim works.

## Direct mode and Tailscale

Skip Cloudflare entirely. The same binary serves MCP itself:

```bash
export GROKCODE_MCP_TOKEN='<another long random token>'
export OPENCODE_PASSWORD='<opencode password>'
grokcode-agent --name laptop --listen 127.0.0.1:8788 --no-spawn --opencode-url http://127.0.0.1:4096
```

Grok Bot then uses URL `http://127.0.0.1:8788/mcp` only from that machine. From other devices, put the listener on the tailnet instead of opening it to the internet yourself.

Recommended: keep the agent on loopback and let Tailscale terminate TLS.

```bash
# private to your tailnet
tailscale serve --bg 443 http://127.0.0.1:8788
# or a public Funnel URL, still gated by GROKCODE_MCP_TOKEN
tailscale funnel --bg 443 http://127.0.0.1:8788
```

Point Grok Bot at `https://<machine>.<tailnet>.ts.net/mcp` (or the Funnel hostname) with `Authorization: Bearer <GROKCODE_MCP_TOKEN>`.

You can also bind the agent to the Tailscale IP (`--listen 100.x.y.z:8788`). Do that only if you understand the host firewall. Binding `0.0.0.0` is supported and still requires the bearer token.

Both modes at once are allowed. The relay does not read the direct listener, and the direct listener does not open a Cloudflare socket. Example: dial the relay for Grok Bot, and keep `--listen 127.0.0.1:8788` for a second client on the tailnet, each with its own token.

## Develop

```bash
npm install
npm test
npm run typecheck
```

Tests cover token checks, the directory allowlist (POSIX and Windows paths), the relay frame protocol, hub routing (including replacement connections and timeouts), the v2 and v1 OpenCode clients against a fake HTTP server, MCP `initialize` / `tools/list` / async prompt / sync-wait budget / permission short-circuit, the Worker auth gate, the direct HTTP server, and the agent WebSocket client.

Layout:

```text
packages/shared        MCP tools, OpenCode client, relay hub, frames
packages/relay-worker  Cloudflare Worker + RelayHubDO
packages/agent         grokcode-agent CLI
deploy/                systemd, launchd, Windows task, example env
```

## Limits

* Sync wait is capped at 20s (hard max 25s) so a Cloudflare request and a typical MCP client timeout are not held for a whole coding turn. Long work is admit + poll.
* `GET /api/session/active` is documented as an object of foreground sessions. The client treats a session id used as a key, or as an entry in an array, as busy. If a future release nests that map differently, `get_session` may report `idle` too early; `get_messages` is still the source of truth.
* The agent does not subscribe to `/api/event`. Permission waits are discovered by polling.
* v1 command and question routes follow the published v1 server doc and may differ on very old builds.
* Live `opencode serve` was not executed in CI. The HTTP client is tested against fixtures shaped like the current v2 and v1 responses.

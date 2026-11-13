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
| `opencode_status` | Whether `opencode serve` is reachable, plus url, version, and pid when known. Does not start or stop anything. |
| `start_opencode` | Start `opencode serve` on the configured host and port. Only call when the user explicitly asks to open/start OpenCode. If one is already reachable, returns its status and does not start another. On Windows the `opencode` name is resolved to `opencode.exe` (or a `.cmd` run via `cmd.exe`), never a `.ps1` or extensionless shim. The process is detached and is not stopped when the agent exits. If it is still booting when the call returns, `reachable` is false and `started` is true. |
| `server_info` | Health, API generation, version, and the agent's default model (`null` when unset). |
| `list_projects` / `list_sessions` | Projects and sessions. |
| `start_session` | New session. `directory` must be absolute. Optional `agent`, `model` (`provider/model`). If `model` is omitted, the agent sends `GROKCODE_DEFAULT_MODEL` when that PC has one. |
| `send_prompt` | Admit a prompt. `wait` defaults to **false**. `wait: true` polls until idle, a permission is pending, or ~20s. |
| `wait_session` | Same poll, without sending another prompt. |
| `get_session` | Status (`idle`, `busy`, `retry`). |
| `get_session_summary` | Status, last activity time, the last assistant message's final text, its finish reason or error, and the last few tool calls. |
| `get_messages` | Transcript. `order` defaults to `desc` (newest first). `limit` caps the page (default 30). `tail` or `last` selects the newest N. Final text comes first; tool calls are a compact list (`includeToolOutput`: `summary` by default, or `full` / `none`). Reasoning is omitted unless `includeReasoning` is true. Cuts keep the end of the text and mark what was removed. |
| `get_message` | One message by id. Page its parts with `partOffset` / `partLimit` (the default page is the last parts) or its text with `offset` / `maxChars`. Omit `offset` to see the end; pass `0` to start at the beginning. |
| `get_diff` | Session or turn diff. |
| `list_pending_permissions` / `respond_permission` | `approve`/`once`, `always`, `deny`/`reject`. |
| `abort` | Interrupt the current turn. |
| `list_agents` / `list_models` | What that server can run. |
| `run_command` | Slash command. |
| `list_forms` / `reply_form` | v2 forms, or the v1 question tool. |
| `delete_session` | Delete a session and its children. |

If a wait hits the budget the tool returns `status: "running"` and you poll `get_session_summary` or `get_messages`, or call `wait_session` again. Pending permissions come back as `status: "needs_permission"` so you can answer them instead of waiting out the clock. A long assistant turn is not one blob of reasoning: `get_session_summary` returns the final text and finish state, and `get_message` pages anything that was cut.

The relay forwards **named operations only**. It is not an open HTTP proxy to the PC.

## Security

This repository is public. Do not commit tokens, `.dev.vars`, real worker hostnames, or account ids.

* **MCP client token** (`MCP_TOKEN` on the Worker, `GROKCODE_MCP_TOKEN` on a direct agent). Grok Bot sends `Authorization: Bearer …`.
* **Per-machine token** (`MACHINE_TOKENS` on the Worker, `GROKCODE_MACHINE_TOKEN` on that PC). The relay checks the bearer token against the name in `X-Grokcode-Machine`. One machine's token does not authenticate as another.
* Tokens shorter than 16 characters are rejected. Comparisons are constant-time. Parse errors for `MACHINE_TOKENS` do not echo the secret.
* The per-PC config file (`~/.config/grokcode/agent.env`, or `%USERPROFILE%\.config\grokcode\agent.env`) may hold the machine token and OpenCode password. Installers create it so only the current user can read it (`chmod 600` on macOS and Linux, a current-user ACL on Windows). A real environment variable overrides the file. Do not commit the file.
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

On the Workers Free plan, register a `workers.dev` subdomain before the first deploy. In the dashboard, open Workers & Pages and set **Your subdomain**. Wrangler prompts for one if it is missing. That name is account-wide. Do not commit it. The deployed URL is `https://<worker-name>.<your-subdomain>.workers.dev`.

Free-plan Durable Objects must use the SQLite backend. `packages/relay-worker/wrangler.toml` creates `RelayHubDO` with `new_sqlite_classes`. The hub routes over hibernated WebSockets and does not use key-value storage, so that backend needs no application change.

`MCP_TOKEN` is one long random string (the Grok Bot bearer token).

`MACHINE_TOKENS` is a JSON object, one entry per PC. Generate each value locally:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

```json
{"laptop":"<token-for-laptop>","desktop":"<token-for-desktop>"}
```

Wrangler prints the worker URL, `https://<worker-name>.<your-subdomain>.workers.dev`. The MCP endpoint is that origin plus `/mcp`. The agent WebSocket is the same origin plus `/agent`. Nothing in the repo should be edited to store that hostname.

Local dry run, with secrets in a gitignored `.dev.vars` copied from `.dev.vars.example`:

```bash
npx wrangler dev
```

`packages/relay-worker/wrangler.toml` has no account id. `nodejs_compat` is on because token comparison uses `node:crypto`.

## Add a new PC

Do this once per computer. Relay mode and direct/Tailscale mode stay independent: a PC can use either, or both, and neither mode calls the other.

1. On the Cloudflare account, register a `workers.dev` subdomain before the first deploy (Workers & Pages → **Your subdomain**). Wrangler prompts for one if it is missing. The name is account-wide. Do not commit it.
2. Generate a token on the new PC and add it to the `MACHINE_TOKENS` secret. `wrangler secret put` replaces the whole secret, so paste the JSON for every machine, not just the new one. Keep that JSON off this repo.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

```bash
cd packages/relay-worker
# Example shape only. Include the existing machines and the new name.
# {"laptop":"<existing-token>","desktop":"<new-token>"}
npx wrangler secret put MACHINE_TOKENS
```

3. Install OpenCode, Node.js 20+, and git on the PC, then run that PC's installer below. Pass the same machine name you used as the JSON key. The installer writes the config, can set OpenCode's own default model, and registers a startup service. It does not print the token or the OpenCode password.

OpenCode's built-in default is often a Google model. If that provider has no key, set `--model` / `-DefaultModel` to a model the PC can actually call, for example `opencode-go/deepseek-v4.1-flash`. `--set-opencode-model` / `-SetOpenCodeModel` writes that into `~/.config/opencode/opencode.json` (or the existing `opencode.jsonc`) as the top-level `model` field and leaves every other setting in place. The agent also applies `GROKCODE_DEFAULT_MODEL` when a caller omits `model`, and `server_info` reports the effective value.

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

Install [OpenCode](https://opencode.ai), Node.js 20 or newer, and git first, and log in to a model provider in the normal way. Then one command per operating system. Each installer checks those tools, clones or updates this repo, builds it, writes the config file, and registers a startup service.

Replace the placeholders. The token is the value you just stored under that machine name in `MACHINE_TOKENS`. The installer generates an OpenCode password when you omit one and stores it in the config file.

### Windows (PowerShell 5.1)

Paste this into PowerShell. It allows scripts for this window only, downloads the installer, clones the repo, and registers a logon task:

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force; $p = Join-Path $env:TEMP 'install-grokcode.ps1'; Invoke-WebRequest -UseBasicParsing -Uri 'https://raw.githubusercontent.com/pilppilo/grokcode/main/deploy/install-windows.ps1' -OutFile $p; & $p -MachineName desktop -RelayUrl 'wss://YOUR_WORKER.workers.dev/agent' -MachineToken 'PASTE_TOKEN' -DefaultModel 'opencode-go/deepseek-v4.1-flash' -SetOpenCodeModel
```

From a checkout you already have:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy\install-windows.ps1 -MachineName desktop -RelayUrl "wss://YOUR_WORKER.workers.dev/agent" -MachineToken "PASTE_TOKEN" -DefaultModel "opencode-go/deepseek-v4.1-flash" -SetOpenCodeModel
```

The task runs `powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File %USERPROFILE%\.config\grokcode\start-agent.ps1` at logon. The launcher loads `agent.env`, puts Node and npm on `PATH`, and loops: it logs a timestamped `starting agent` line, runs `node dist\cli.js` with hidden stdout and stderr logs, then waits 10 seconds after the process exits. Task Scheduler also restarts the launcher up to 10 times, a minute apart, with no execution time limit. Re-running the installer replaces the task. Logs (`agent.log`, `agent-out.log`, `agent-err.log`) rotate at 1 MB. `-NoStart` registers the task without starting it. Add `-Listen 127.0.0.1:8788 -McpToken "..."` for direct mode, with or without the relay.

### Linux

```bash
curl -fsSL https://raw.githubusercontent.com/pilppilo/grokcode/main/deploy/install-linux.sh | bash -s -- \
  --name desktop \
  --relay wss://YOUR_WORKER.workers.dev/agent \
  --token PASTE_TOKEN \
  --model opencode-go/deepseek-v4.1-flash \
  --set-opencode-model
```

From a checkout: `bash deploy/install-linux.sh` with the same flags. This installs a systemd user service (`grokcode-agent`) and tries `loginctl enable-linger`. The unit does not contain tokens. The agent reads `~/.config/grokcode/agent.env`.

```bash
systemctl --user status grokcode-agent
journalctl --user -u grokcode-agent -f
```

### macOS

```bash
curl -fsSL https://raw.githubusercontent.com/pilppilo/grokcode/main/deploy/install-macos.sh | bash -s -- \
  --name desktop \
  --relay wss://YOUR_WORKER.workers.dev/agent \
  --token PASTE_TOKEN \
  --model opencode-go/deepseek-v4.1-flash \
  --set-opencode-model
```

From a checkout: `bash deploy/install-macos.sh` with the same flags. This bootstraps a LaunchAgent. Tokens stay in `~/.config/grokcode/agent.env`. Logs are `~/.config/grokcode/agent.log` and `agent.err.log`.

Direct mode on either Unix installer: add `--listen 127.0.0.1:8788 --mcp-token PASTE_MCP_TOKEN`. Omit `--relay` and `--token` to use only direct mode. `--no-start` writes the config and the service unit without starting it.

### What the agent reads

On every OS the agent loads, in order, `agent.json` then `agent.env` from `~/.config/grokcode` (`%USERPROFILE%\.config\grokcode` on Windows). `--config` or `GROKCODE_CONFIG` selects a file or a directory instead. Real environment variables override the file, except `GROKCODE_OPENCODE_MODE`: a mode written in the config file wins over a process environment value and over `GROKCODE_SPAWN`, so a stale `auto` cannot start a server the file set to `attach`. CLI flags (`--opencode-mode`, `--spawn`, `--no-spawn`) still win. Tokens may live in either file. The startup log names the mode and where it came from. Files written by Windows PowerShell 5.1 (`Set-Content` ANSI or Unicode, CRLF) are accepted.

`GROKCODE_OPENCODE_MODE` is `attach` (default), `auto`, or `spawn`.

* **attach** (default, also `--no-spawn`) never starts, restarts, or kills OpenCode. If the server is down or rejects `OPENCODE_PASSWORD`, the agent stays up, tool calls report OpenCode unavailable, and it retries the connection with backoff (1s, 2s, … up to 30s). It does not stop a server on the way out, including one started earlier by `start_opencode`.
* **auto** attaches when an OpenCode server is already listening and accepts `OPENCODE_PASSWORD`, and says so in the log, including that this agent did not start it and will not stop it. If the password is rejected, the agent starts its own server on another port. A server it is supervising is reused, restarted if it dies, and stopped when the agent exits. A server marked detached in `opencode.pid` is left alone.
* **spawn** (`--spawn`) owns the process it launches. A foreign server on the port is replaced. Set `GROKCODE_OPENCODE_ON_FOREIGN=next-port` to move aside instead, or `attach` to keep a server that accepts the password.

The process reconnects to the relay with backoff (1s, 2s, … up to 30s). `SIGINT` / `SIGTERM` stop the agent. They stop an OpenCode process only when this run is supervising it (`auto` or `spawn`). `start_opencode` launches a detached process, so it survives an agent exit or crash and is not part of the agent's process tree.

Foreground run, after `npm install` and `npm run build` in a checkout:

```bash
node packages/agent/dist/cli.js --help
```

```bash
export GROKCODE_MACHINE_TOKEN='<the token from MACHINE_TOKENS>'
export OPENCODE_PASSWORD='<a long password>'
node packages/agent/dist/cli.js --name laptop --relay wss://YOUR_WORKER.workers.dev/agent
```

In `spawn` and `auto`, `opencode serve` is started with `shell` on Windows so an `opencode.cmd` shim works. The agent records the listener pid and stops that supervised process tree on exit. `start_opencode` is different: on Windows it uses `Start-Process` without `-Wait`, so `deploy/start-agent.ps1` does not hang and the server keeps running after the agent exits.

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

Tests cover token checks, the directory allowlist (POSIX and Windows paths), config loading (env and JSON files, with real environment variables overriding the file), the default model on `start_session`, `send_prompt`, and `server_info`, the default `attach` OpenCode mode, `start_opencode` idempotency and the rule that an agent exit does not kill a detached server, OpenCode config edits that keep unrelated keys, OpenCode process ownership (`auto` / `attach` / `spawn`), the relay frame protocol (including chunked results and oversized frames), hub routing (including replacement connections and timeouts), the v2 and v1 OpenCode clients against a fake HTTP server, message projection for long v2 and v1 assistant turns, MCP `initialize` / `tools/list` / async prompt / sync-wait budget / permission short-circuit, the Worker auth gate, the direct HTTP server, and the agent WebSocket client.

Layout:

```text
packages/shared        MCP tools, OpenCode client, relay hub, frames
packages/relay-worker  Cloudflare Worker + RelayHubDO
packages/agent         grokcode-agent CLI
deploy/                systemd, launchd, Windows task and launcher, per-OS installers, example env
```

## Limits

* Sync wait is capped at 20s (hard max 25s) so a Cloudflare request and a typical MCP client timeout are not held for a whole coding turn. Long work is admit + poll.
* `GET /api/session/active` is documented as an object of foreground sessions. The client treats a session id used as a key, or as an entry in an array, as busy. If a future release nests that map differently, `get_session` may report `idle` too early; `get_messages` and `get_session_summary` are still the source of truth.
* `get_messages` does not return the raw OpenCode message. Reasoning is left out unless `includeReasoning` is true, tool output defaults to a short tail, and final text over the per-message cap keeps its end with an `omitted … from the start` marker. `get_message` is how you read the rest, by parts or by character offset. The same projection is used for v2 `content` parts and the v1 `{ info, parts }` shape.
* Relay results larger than 900,000 characters (under the 1 MiB WebSocket message limit) are split into numbered chunks and reassembled by the hub. A frame that still cannot be parsed fails the call with `frame_too_large` instead of being dropped. The MCP text cap is 80,000 characters and also keeps the end.
* The agent does not subscribe to `/api/event`. Permission waits are discovered by polling.
* v1 command and question routes follow the published v1 server doc and may differ on very old builds.
* Live `opencode serve` was not executed in CI. The HTTP client is tested against fixtures shaped like the current v2 and v1 responses.

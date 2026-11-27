# Gemini shell bridge

This is the shell and file bridge for the Gemini app (custom apps / Connected Apps) and the Antigravity CLI (`agy`). It does not replace the OpenCode tools on `/mcp`. Those stay on the static bearer token.

```text
Gemini app  --OAuth 2.1 + HTTPS-->  Worker /gemini/mcp  --WebSocket-->  grokcode-agent  --policy-->  pwsh or bash
agy         --stdio-->  grokcode-shell  --policy-->  local files and programs
```

Command output crosses Google and Cloudflare when you use the remote endpoint. Keep the agent on a normal user account, and keep `policy.json` outside the directories the tools are allowed to touch.

No real token belongs in git. The relay worker deploys from GitHub Actions when a change that affects it reaches `main`. See [Deploy the worker](#deploy-the-worker).

## What the worker exposes

| Path | Who | Auth |
| --- | --- | --- |
| `/mcp` | Grok Bot and other bearer clients | `Authorization: Bearer <MCP_TOKEN>` |
| `/gemini/mcp` | Gemini custom apps | OAuth 2.1 access token |
| `/oauth/authorize`, `/oauth/token`, `/oauth/register` | Gemini's OAuth client | Public discovery |
| `/.well-known/oauth-authorization-server` | Gemini | Public |
| `/.well-known/oauth-protected-resource` and `.../gemini/mcp` | Gemini | Public |
| `/agent` | Each PC | Per-machine token, unchanged |

The worker implements OAuth 2.1 for the Gemini endpoint, including RFC 8414 metadata, RFC 9728 protected-resource metadata, S256 PKCE, and RFC 7591 dynamic client registration. A refresh token is stable: every refresh returns that same token. It expires 90 days after it was created, and a refresh does not move that deadline. Access tokens last one hour and are bound to `https://<origin>/gemini/mcp`. Clients can revoke tokens at `/oauth/revoke`. Dynamic registration allows up to 50 active clients by default. Each dynamic client expires after 90 days and frees a registration slot.

Without pins, Gemini can register the six official Connected Apps callbacks: `https` on `oauth-redirect.googleusercontent.com`, `oauth-redirect-sandbox.googleusercontent.com`, and `oauth-redirect-test.googleusercontent.com`, each under `/r/` or `/a/`, with no port. Other paths, ports, schemes, and hosts are rejected, including loopback. Configure `OAUTH_PINNED_REDIRECTS` to require exact callbacks, including for loopback development clients. Set `PUBLIC_ORIGIN` to the origin clients use when the worker's request host is not that URL (a custom domain, or a proxy in front of `*.workers.dev`).

Google sign-in does not issue a code immediately. After the Google account is accepted, the browser shows a consent page with the client name, client id, and the exact redirect URI. The form carries a one-time CSRF token. `OWNER_APPROVAL_SECRET` is ignored while Google sign-in is configured, and it never mints a token whose subject skips `OWNER_EMAILS`.

## Deploy the worker

From a clone, with Node 20+:

```bash
npm install
npm run build
cd packages/relay-worker
npx wrangler login
npx wrangler secret put MCP_TOKEN
npx wrangler secret put MACHINE_TOKENS
```

Pushes to `main` also deploy this worker from [`.github/workflows/deploy-relay.yml`](../.github/workflows/deploy-relay.yml) after `npm test` and `npm run typecheck` pass. That workflow needs two repository secrets: `CLOUDFLARE_API_TOKEN` (create the token from the **Edit Cloudflare Workers** template) and `CLOUDFLARE_ACCOUNT_ID` (the account id, stored as a secret or as an Actions variable of the same name). The deploy job uses the GitHub environment `production`.

Set worker secrets separately with `wrangler secret put`. The GitHub deploy does not send or replace them. That includes `MCP_TOKEN`, `MACHINE_TOKENS`, `OWNER_EMAILS`, `OWNER_APPROVAL_SECRET`, and the Google and OAuth secrets below. The full path list is in the README deploy section.

`packages/relay-worker/wrangler.toml` adds a second SQLite Durable Object, `OAuthStoreDO`, in migration `v2`. `wrangler deploy` applies it. Do not put an account id or a hostname in the toml.

Pick one owner gate.

Google sign-in (the account that may click through Gemini's consent screen):

```bash
npx wrangler secret put OWNER_EMAILS
# you@gmail.com
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

In Google Cloud, create an OAuth client of type Web application. Add this authorized redirect URI, using the hostname Wrangler prints:

```text
https://<worker>.<your-subdomain>.workers.dev/oauth/google/callback
```

The Google client needs the `openid` and `email` scopes. Only an address listed in `OWNER_EMAILS` (comma-separated, compared case-insensitively) receives a code. Any other Google account gets a 403 and no token. `email_verified` must be true. The consent page is the step that calls `finish()`; closing it issues nothing.

`PUBLIC_ORIGIN` is optional. Set it when Gemini should see a stable issuer that is not the host of the incoming request:

```bash
npx wrangler secret put PUBLIC_ORIGIN
# https://shell.example.com
```

To restrict registration to known callbacks, configure their exact URIs:

```bash
npx wrangler secret put OAUTH_PINNED_REDIRECTS
# https://oauth-redirect.googleusercontent.com/r/your-app
```

Or skip Google and use approval-secret mode. Approval-secret mode needs both `OWNER_EMAILS` and an `OWNER_APPROVAL_SECRET` of at least 16 characters. `OWNER_EMAILS` is the address written onto the token. The approval secret is the password the consent page asks for. If either value is missing, or the secret is shorter than 16 characters, `/oauth/authorize` returns 503 before the form is shown. An empty `OWNER_EMAILS` still fails inside `approve()` with "Set OWNER_EMAILS to use the approval secret" if a request reaches that step. Gemini still redirects a browser at `/oauth/authorize`. The page asks for the secret and does not set a cookie.

```bash
npx wrangler secret put OWNER_EMAILS
# you@gmail.com
npx wrangler secret put OWNER_APPROVAL_SECRET
# at least 16 characters
```

Three wrong secrets expire an approval transaction. Ten failed attempts within an hour lock approval-secret mode for one hour. Google sign-in is preferred and uses its own approval flow. Leave `OWNER_APPROVAL_SECRET` unset when you use Google. `OWNER_EMAILS` is still required.

Optional pre-registered client, if you would rather type a client id and secret into Gemini than use dynamic registration:

```bash
npx wrangler secret put OAUTH_CLIENTS
```

```json
[{"clientId":"gemini-manual","clientSecret":"replace-with-at-least-16-characters","redirectUris":["https://oauth-redirect.googleusercontent.com/r/YOUR_APP"]}]
```

Then:

```bash
npx wrangler deploy
```

The shell endpoint is `https://<worker>.<your-subdomain>.workers.dev/gemini/mcp`.

Confirm discovery before connecting Gemini:

```bash
curl -sS https://<worker>.<your-subdomain>.workers.dev/.well-known/oauth-authorization-server
curl -sS https://<worker>.<your-subdomain>.workers.dev/.well-known/oauth-protected-resource/gemini/mcp
```

The authorization metadata must include `authorization_endpoint`, `token_endpoint`, `registration_endpoint`, `response_types_supported` containing `code`, and `code_challenge_methods_supported` containing `S256`.

## Install the agent

Use the existing installers. They already register the logon task (Windows), the systemd user service (Linux), or the LaunchAgent (macOS). The Windows installer always copies `policy.example.json` from the repo it just updated into `%USERPROFILE%\.config\grokcode\`, including on a reinstall that reuses `~\.grokcode\repo` (that path is fast-forwarded to latest `main` first). The Linux and macOS installers copy the example when `policy.json` is absent.

Windows (`my-pc`) uses PowerShell 7 (`pwsh`) for the opt-in shell mode. The agent process itself is Node. Install PowerShell 7 so `pwsh` is on `PATH` if you later set `allowShell`. The scheduled task must stay a logon task for your user, not an Administrator or SYSTEM task. Run the installer from Windows PowerShell 5.1 as documented in the README; that host is only the installer.

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force; $p = Join-Path $env:TEMP 'install-grokcode.ps1'; Invoke-WebRequest -UseBasicParsing -Uri 'https://raw.githubusercontent.com/pilppilo/grokcode/main/deploy/install-windows.ps1' -OutFile $p; & $p -MachineName my-pc -RelayUrl 'wss://YOUR_WORKER.workers.dev/agent' -MachineToken 'PASTE_TOKEN'
```

Linux, same flags as the README (`--name`, `--relay`, `--token`). The systemd unit is a user service. Do not run it as root.

On each PC, copy the example and edit roots. Roots are absolute or `~`. A filesystem root (`/`, `C:\`) is rejected. An empty file, or no file, denies every command and every file tool.

```bash
cp ~/.config/grokcode/policy.example.json ~/.config/grokcode/policy.json
```

```powershell
Copy-Item "$env:USERPROFILE\.config\grokcode\policy.example.json" "$env:USERPROFILE\.config\grokcode\policy.json"
```

`GROKCODE_SHELL_POLICY` overrides that path. The agent re-reads the file on each call. Every call is appended to `shell-audit.log` in the same directory, including patch and commit paths, with obvious secrets redacted. A policy root that contains the policy file or the audit log is refused. Restart is not required after a policy edit. The process does reconnect on its own if you restart it.

`get_machine_info` reports `windows` and `pwsh` on `my-pc`, and `linux` and `bash` on the Linux machines. Paths are compared with `path.win32` or `path.posix`. Windows comparisons are case-insensitive. Commands must be a bare name (`git`, not `./git` or `.\git.cmd`). The name is resolved from a fixed `PATH` that drops `.` and any directory inside a policy root. `.cmd`, `.bat`, and `.com` are rejected for now, because `git` and `rg` are `.exe`. Allowing `npm`, `pnpm`, or `npx` shims later means adding those bare names to `SCRIPT_SHIM_ALLOWLIST` in `packages/shell/src/spawn.ts`; `quoteCmdArg` already rejects `;`, `,`, and `=`. Child processes receive a minimal environment (`PATH`, `HOME` or `USERPROFILE`, `SystemRoot`, `TEMP`, `LANG`, and similar) plus UTF-8 (`PYTHONIOENCODING`, `LC_ALL=C.UTF-8`). `GIT_*`, `LD_PRELOAD`, `NODE_OPTIONS`, and `RIPGREP_CONFIG_PATH` are not passed through. Windows short names (`GIT~1`) and trailing dots or spaces (`id_rsa.`, `.git.`) are denied.

## Policy

`packages/shell/policy.example.json` is the starting point. `allow` is the only command list. Shells and interpreters (`bash`, `pwsh`, `python`, `node`, and the rest) stay denied unless `allowInterpreters` is true, and even then `sudo`, `format`, and `rm -rf /` stay denied. `git -c`, `git` aliases, `--upload-pack`, `--receive-pack`, `core.fsmonitor`, and `core.sshCommand` are denied so a flag cannot turn `git` into a program runner. `find -exec`, `tar --to-command`, `rsync -e`, and `rg --pre` are denied for the same reason.

`allowShell` defaults to false. Setting `allowShell` to true means an arbitrary shell: the command string is passed to `pwsh -NoProfile -NonInteractive -Command` on Windows and `bash --noprofile --norc -c` on Linux, with shell interpretation. Pipe-to-shell (`curl | sh`, `irm | iex`) is still denied. Leave it false unless you accept that.

`git.branches` gates `git_commit_push`. `git.push` must be true before any push, including `run_command`. `git_commit_push` with `push` true checks `git.push` before `git add` or `git commit`. When push is disabled, that call returns `push_denied` and leaves the index and HEAD unchanged. A successful commit result includes the commit SHA. If the commit succeeds and the push itself fails, the tool result has `isError: true` and still includes the commit SHA plus the push error. The message says the commit already exists and that only the push should be retried. The only accepted push is `origin` plus `HEAD:<allowlisted branch>`. A leading `+`, `--force`, and remote-helper URLs such as `ext::` are denied. Paths are the ones you name. There is no `git add -A`. `git_status` runs only when `status` is allowlisted.

Every git spawn, including `git_status`, `git_diff`, `git_log`, `git_commit_push`, and `run_command` git, adds `-c core.fsmonitor=`, `-c core.hooksPath=NUL` (Windows) or `/dev/null` (Linux), `-c protocol.ext.allow=never`, `-c core.sshCommand=`, `-c core.pager=cat`, `-c diff.external=`, and `HUSKY=0`. `git add` also clears clean, smudge, and process filters. `rg` accepts only a fixed flag set (`-F`, `-n`, `-i`, `-w`, `-l`, context and max-count flags). `--hidden`, `--no-ignore`, `-u`, and `--glob` are denied. `git show HEAD:.env` and any object spec whose path is sensitive is denied.

File tools resolve the real path, canonicalize the existing prefix with `realpath`, and refuse a symlink that lands outside the roots, a Windows alternate data stream, a `.git` path segment, a `gitdir:` file, and paths such as `.ssh` and `.env`. `.gitignore`, `.gitattributes`, and `.github/` stay readable.

Read-only tools (`readOnlyHint`): `list_machines`, `get_machine_info`, `get_job`, `poll_output`, `read_file`, `list_dir`, `search_files`, `git_status`, `git_diff`, `git_log`. Destructive tools: `run_command`, `write_file`, `edit_file`, `apply_patch`, `send_input`, `kill_job`, `git_commit_push`. Gemini shows its confirmation card for the destructive tools. The PC does not ask again.

Use `edit_file` with `path`, `oldText`, and `newText` for an exact edit to an existing UTF-8 file. Set `replaceAll: true` for all non-overlapping matches. Otherwise the old text must occur once. Use an empty `newText` to delete the match. Matching treats LF and CRLF as equivalent, preserves untouched line endings, and uses the file's dominant style for extra newlines. The agent serializes edits to each file within its process and preserves file permissions. The response reports replacement and line counts. If the diff exceeds its computation budget, `diff.exact: false` indicates whole-file line counts.

Audit rows include `bytesReturned` (UTF-8 bytes of the serialized machine result or tool error), `estimatedTokens` (bytes divided by four, rounded up), `exitCode` when available, `durationMs`, `truncated`, and `sessionId`. The byte count excludes transport framing. One Gemini tool call can produce more than one machine operation, such as command admission followed by a status hold. Stdin writes also record a pre-write admission row with zero returned bytes.

Run `grokcode audit` for per-tool calls, denials, bytes, and busiest hours in UTC. It reads the active log and its latest rotation. Use `grokcode audit --file <path>` for a custom log path.

The Gemini endpoint returns a soft `Mcp-Session-Id` header on initialization. Send it with subsequent requests to keep job IDs, saved output, and completion notices scoped to the chat. A relay restart preserves the scope. After an agent restart, the same header still works, and in-memory jobs from the old process are gone. Clients that omit the header share a fallback scope within their OAuth identity and client. The machine audit log records a stable session fingerprint.

`run_command` waits up to 45 seconds by default. Use `wait: false` to return immediately with a job ID. Each `get_job` call waits up to 45 seconds for completion. Set `wait: false` for an immediate status snapshot. Set the relay variable `MAX_SYNC_WAIT_MS` to shorten both holds. The command timeout still comes from the machine policy and the requested `timeoutMs`. Pass `nextOffset` to `poll_output` for the next page, or cancel a running command with `kill_job`.

Command and test-job responses show up to 10 KiB from each end of the sanitized output. Set `limits.outputPreviewBytes` in the machine policy to lower the per-end budget. The preview also respects `limits.maxOutputBytes`. When `omittedBytes` is positive, `headBytes` identifies where the two parts meet. ANSI escapes and recognized credentials are removed before output is returned or saved.

When a job finishes, pass its `outputFile` value as the path to `read_file` to page through the complete sanitized log while the job is still known to the agent. The logs live in the configuration directory under `outputs/` (normally `~/.config/grokcode/outputs/`). Each completed job triggers cleanup of logs older than seven days and keeps at most 32 logs. A separate 16 MiB capture limit stops runaway output. Such jobs report `captureLimitReached` and retain the sanitized complete lines captured before the limit.

### Experimental read-only code mode

Set `ENABLE_CODE_MODE=1` on the relay and `GROKCODE_ENABLE_CODE_MODE=1` on the agent to opt in. The agent requires a configured audit log. `execute` accepts an async JavaScript function body, for example `return (await tools.read_file({ path: "/repo/README.md" })).content;`. Use `poll_execution` with the returned machine and execution ID to wait again, or `cancel_execution` to stop the run. Set `wait: false` for an immediate response. The default hold is 45 seconds and follows `MAX_SYNC_WAIT_MS`.

QuickJS/Wasm runs on the selected agent. Its only host capabilities are `tools.read_file`, `tools.list_dir`, and `tools.search_files`. Every nested call uses the agent's normal path policy and audit log. An allowed read whose audit write fails returns an error in place of the data. Polling and cancellation require the same OAuth account and client that started the execution. Runs and results are held in agent memory and results expire after ten minutes.

Each run has limits of 8 KiB of source, 8 MiB of sandbox memory, one second of guest CPU time, and two minutes of elapsed time. It can make up to 32 nested reads, four at once, with at most 512 KiB of nested results and a 32 KiB final result. An agent runs at most two scripts concurrently.

## Add the custom app in Gemini

Requirements on the Google account: a personal account, Gemini Apps Activity on, and a region where custom apps are available (Google currently requires the United States for this flow).

1. Open [gemini.google.com](https://gemini.google.com).
2. Settings, then Connected Apps, then Custom apps. For a test pass, use Developer Mode at [gemini.google.com/devmode](https://gemini.google.com/devmode) and choose Create new.
3. MCP Server URL: `https://<worker>.<your-subdomain>.workers.dev/gemini/mcp`
4. Leave the client id blank to use dynamic registration. If you stored `OAUTH_CLIENTS`, open Additional settings and paste that client id and secret.
5. Accept the security prompt and connect. The browser is sent to the worker. Sign in with the allowlisted Google account, or type the approval secret.
6. Save the app once the tool list shows `list_machines`, `run_command`, `read_file`, and the rest.

Gemini snapshots the tool list. Adding or renaming tools later can break a saved app. Keep this endpoint stable, or put a new shape on a new path.

Use OAuth for the Gemini custom app. For Antigravity, use the local stdio configuration below.

## Antigravity CLI

Antigravity speaks stdio and Streamable HTTP. The config file is `~/.gemini/config/mcp_config.json`, or `%USERPROFILE%\.gemini\config\mcp_config.json` on Windows. `packages/shell/mcp_config.example.json` is a template.

Local stdio (no Cloudflare, the policy file is read on that PC):

```bash
npm install
npm run build
node packages/shell/dist/cli.js --policy ~/.config/grokcode/policy.json --name my-pc
```

```json
{
  "mcpServers": {
    "grokcode-shell": {
      "command": "node",
      "args": ["C:\\src\\grokcode\\packages\\shell\\dist\\cli.js"],
      "env": {
        "GROKCODE_SHELL_POLICY": "C:\\Users\\you\\.config\\grokcode\\policy.json",
        "GROKCODE_MACHINE_NAME": "my-pc"
      }
    }
  }
}
```

`enabledTools` and `disabledTools` are Antigravity fields. The server still enforces the policy if a tool is left enabled. Antigravity's own permission settings are documented at [antigravity.google/docs/permissions](https://antigravity.google/docs/permissions/). The stdio process logs to stderr. stdout is only MCP frames.

## Tools

Every tool takes `machine` except `list_machines`, which is required when more than one PC is online.

| Tool | Notes |
| --- | --- |
| `list_machines` | Connected agents with OS and allowed roots when available. Read-only. |
| `get_machine_info` | OS, shell, roots, allowlisted commands and subcommands. Read-only. |
| `run_command` | `argv` plus absolute `cwd`. No shell unless `shell` is true, and `allowShell: true` means an arbitrary shell. Returns a job id. Destructive. |
| `get_job` / `poll_output` | Status and output for that job. Read-only. |
| `read_file` / `list_dir` | Inside the roots. Reads return up to 800 lines or 46,000 source bytes per page. Responses include the page line range, file totals, and `hasMore`. To continue, pass `nextOffset` as `offset` with the same path and inclusive line range. Directories return the first 500 sorted entries and report truncation. Read-only. |
| `search_files` | Literal text lookup with an optional filename glob. Skips hidden paths and symlinks. Read-only. |
| `git_status` | Fixed `git status --porcelain`. Requires the `status` allowlist entry. Read-only. |
| `git_diff` / `git_log` | Unstaged changes by default, staged changes on request, and recent commit history. Read-only. |
| `list_jobs` | List retained jobs and collect unread job completion notices for the current session. |
| `send_input` | Write text to a running command started with `stdin: true`. Requires `allowJobInput: true` and an available audit log. Include a newline for line-oriented prompts. |
| `kill_job` | Terminate a running command and its process tree on the selected machine. Destructive. |
| `write_file` / `apply_patch` | Inside the roots. Unified diffs. Destructive. |
| `git_commit_push` | Named paths and a branch allowlist. Push is refused before any commit when `git.push` is false. A push failure after a commit returns the commit SHA and the push error, with `isError` set, and says to retry only the push. Destructive. |

With `search_files`, omit `cwd` to search the named project's root. Results report the requested directory, any filename glob, and the active exclusions. Set `includeIgnored: true` to include the default-skipped directories and follow pnpm package aliases whose targets are in the same search scope. The total read budget is 8 MB by default and 32 MB with `includeIgnored`. A search scoped directly to a dependency includes its build folders by default. To search source maps, use a glob ending in `.map`. `resultsCapped` indicates omitted matches, `filesPartiallyScanned` indicates incomplete file reads, and `scanLimit` identifies an entry or byte budget that stopped traversal.

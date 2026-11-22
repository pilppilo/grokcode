# Gemini shell bridge

This is the shell and file bridge for the Gemini app (custom apps / Connected Apps) and the Antigravity CLI (`agy`). It does not replace the OpenCode tools on `/mcp`. Those stay on the static bearer token.

```text
Gemini app  --OAuth 2.1 + HTTPS-->  Worker /gemini/mcp  --WebSocket-->  grokcode-agent  --policy-->  pwsh or bash
agy         --stdio-->  grokcode-shell  --policy-->  local files and programs
agy         --Streamable HTTP + bearer-->  Worker /gemini/mcp  --WebSocket-->  grokcode-agent
```

Command output crosses Google and Cloudflare when you use the remote endpoint. Keep the agent on a normal user account, and keep `policy.json` outside the directories the tools are allowed to touch.

Nothing in this repository is deployed for you, and no real token belongs in git.

## What the worker exposes

| Path | Who | Auth |
| --- | --- | --- |
| `/mcp` | Grok Bot and other bearer clients | `Authorization: Bearer <MCP_TOKEN>` |
| `/gemini/mcp` | Gemini custom apps | OAuth 2.1 access token |
| `/gemini/mcp` | Antigravity remote | The same `MCP_TOKEN` bearer header |
| `/oauth/authorize`, `/oauth/token`, `/oauth/register` | Gemini's OAuth client | Public discovery |
| `/.well-known/oauth-authorization-server` | Gemini | Public |
| `/.well-known/oauth-protected-resource` and `.../gemini/mcp` | Gemini | Public |
| `/agent` | Each PC | Per-machine token, unchanged |

`@cloudflare/workers-oauth-provider` owns the worker entrypoint and treats its API route as OAuth-only. That would reject Antigravity's static bearer and wrap `/mcp` and `/agent`. The worker therefore implements the OAuth 2.1 surface itself: RFC 8414 metadata, RFC 9728 protected-resource metadata, S256 PKCE, and RFC 7591 dynamic client registration. A refresh token is stable: every refresh returns that same token. It expires 90 days after it was created, and a refresh does not move that deadline. Access tokens last one hour and are bound to `https://<origin>/gemini/mcp`. Clients can revoke tokens at `/oauth/revoke`. Dynamic registration is capped (50 clients unless the process is restarted with a fresh store).

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

If Google credentials and the approval secret are both set, Google sign-in is what Gemini's browser hits. Leave `OWNER_APPROVAL_SECRET` unset when you use Google. `OWNER_EMAILS` is still required.

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

Windows (`expinsider`) uses PowerShell 7 (`pwsh`) for the opt-in shell mode. The agent process itself is Node. Install PowerShell 7 so `pwsh` is on `PATH` if you later set `allowShell`. The scheduled task must stay a logon task for your user, not an Administrator or SYSTEM task. Run the installer from Windows PowerShell 5.1 as documented in the README; that host is only the installer.

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force; $p = Join-Path $env:TEMP 'install-grokcode.ps1'; Invoke-WebRequest -UseBasicParsing -Uri 'https://raw.githubusercontent.com/pilppilo/grokcode/main/deploy/install-windows.ps1' -OutFile $p; & $p -MachineName expinsider -RelayUrl 'wss://YOUR_WORKER.workers.dev/agent' -MachineToken 'PASTE_TOKEN'
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

`get_machine_info` reports `windows` and `pwsh` on `expinsider`, and `linux` and `bash` on the Linux machines. Paths are compared with `path.win32` or `path.posix`. Windows comparisons are case-insensitive. Commands must be a bare name (`git`, not `./git` or `.\git.cmd`). The name is resolved from a fixed `PATH` that drops `.` and any directory inside a policy root. `.cmd`, `.bat`, and `.com` are rejected for now, because `git` and `rg` are `.exe`. Allowing `npm`, `pnpm`, or `npx` shims later means adding those bare names to `SCRIPT_SHIM_ALLOWLIST` in `packages/shell/src/spawn.ts`; `quoteCmdArg` already rejects `;`, `,`, and `=`. Child processes receive a minimal environment (`PATH`, `HOME` or `USERPROFILE`, `SystemRoot`, `TEMP`, `LANG`, and similar) plus UTF-8 (`PYTHONIOENCODING`, `LC_ALL=C.UTF-8`). `GIT_*`, `LD_PRELOAD`, `NODE_OPTIONS`, and `RIPGREP_CONFIG_PATH` are not passed through. Windows short names (`GIT~1`) and trailing dots or spaces (`id_rsa.`, `.git.`) are denied.

## Policy

`packages/shell/policy.example.json` is the starting point. `allow` is the only command list. Shells and interpreters (`bash`, `pwsh`, `python`, `node`, and the rest) stay denied unless `allowInterpreters` is true, and even then `sudo`, `format`, and `rm -rf /` stay denied. `git -c`, `git` aliases, `--upload-pack`, `--receive-pack`, `core.fsmonitor`, and `core.sshCommand` are denied so a flag cannot turn `git` into a program runner. `find -exec`, `tar --to-command`, `rsync -e`, and `rg --pre` are denied for the same reason.

`allowShell` defaults to false. Setting `allowShell` to true means an arbitrary shell: the command string is passed to `pwsh -NoProfile -NonInteractive -Command` on Windows and `bash --noprofile --norc -c` on Linux, with shell interpretation. Pipe-to-shell (`curl | sh`, `irm | iex`) is still denied. Leave it false unless you accept that.

`git.branches` gates `git_commit_push`. `git.push` must be true before any push, including `run_command`. The only accepted push is `origin` plus `HEAD:<allowlisted branch>`. A leading `+`, `--force`, and remote-helper URLs such as `ext::` are denied. Paths are the ones you name. There is no `git add -A`. `git_status` runs only when `status` is allowlisted.

Every git spawn, including `git_status`, `git_diff`, `git_log`, `git_commit_push`, and `run_command` git, adds `-c core.fsmonitor=`, `-c core.hooksPath=NUL` (Windows) or `/dev/null` (Linux), `-c protocol.ext.allow=never`, `-c core.sshCommand=`, `-c core.pager=cat`, `-c diff.external=`, and `HUSKY=0`. `git add` also clears clean, smudge, and process filters. `rg` accepts only a fixed flag set (`-F`, `-n`, `-i`, `-w`, `-l`, context and max-count flags). `--hidden`, `--no-ignore`, `-u`, and `--glob` are denied. `git show HEAD:.env` and any object spec whose path is sensitive is denied.

File tools resolve the real path, canonicalize the existing prefix with `realpath`, and refuse a symlink that lands outside the roots, a Windows alternate data stream, a `.git` path segment, a `gitdir:` file, and paths such as `.ssh` and `.env`. `.gitignore`, `.gitattributes`, and `.github/` stay readable.

Read-only tools (`readOnlyHint`): `list_machines`, `get_machine_info`, `get_job`, `poll_output`, `read_file`, `list_dir`, `search_files`, `git_status`, `git_diff`, `git_log`. Destructive tools: `run_command`, `write_file`, `apply_patch`, `kill_job`, `git_commit_push`. Gemini shows its confirmation card for the destructive tools. The PC does not ask again.

`run_command` waits up to about 20 seconds by default. Use `wait: false` to return immediately with a job ID. Poll `get_job` for status, pass `nextOffset` to `poll_output` for the next page, or cancel a running command with `kill_job`.

## Add the custom app in Gemini

Requirements on the Google account: a personal account, Gemini Apps Activity on, and a region where custom apps are available (Google currently requires the United States for this flow).

1. Open [gemini.google.com](https://gemini.google.com).
2. Settings, then Connected Apps, then Custom apps. For a test pass, use Developer Mode at [gemini.google.com/devmode](https://gemini.google.com/devmode) and choose Create new.
3. MCP Server URL: `https://<worker>.<your-subdomain>.workers.dev/gemini/mcp`
4. Leave the client id blank to use dynamic registration. If you stored `OAUTH_CLIENTS`, open Additional settings and paste that client id and secret.
5. Accept the security prompt and connect. The browser is sent to the worker. Sign in with the allowlisted Google account, or type the approval secret.
6. Save the app once the tool list shows `list_machines`, `run_command`, `read_file`, and the rest.

Gemini snapshots the tool list. Adding or renaming tools later can break a saved app. Keep this endpoint stable, or put a new shape on a new path.

There is no static `Authorization` header field in the custom-app dialog. That is why OAuth is required for Gemini and why the bearer token remains available for Antigravity on the same URL.

## Antigravity CLI

Antigravity speaks stdio and Streamable HTTP. The config file is `~/.gemini/config/mcp_config.json`, or `%USERPROFILE%\.gemini\config\mcp_config.json` on Windows. `packages/shell/mcp_config.example.json` is a template.

Local stdio (no Cloudflare, the policy file is read on that PC):

```bash
npm install
npm run build
node packages/shell/dist/cli.js --policy ~/.config/grokcode/policy.json --name expinsider
```

```json
{
  "mcpServers": {
    "grokcode-shell": {
      "command": "node",
      "args": ["C:\\src\\grokcode\\packages\\shell\\dist\\cli.js"],
      "env": {
        "GROKCODE_SHELL_POLICY": "C:\\Users\\you\\.config\\grokcode\\policy.json",
        "GROKCODE_MACHINE_NAME": "expinsider"
      }
    }
  }
}
```

Remote, same tools, using the relay bearer token:

```json
{
  "mcpServers": {
    "grokcode-shell-remote": {
      "serverUrl": "https://<worker>.<your-subdomain>.workers.dev/gemini/mcp",
      "headers": { "Authorization": "Bearer <MCP_TOKEN>" }
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
| `read_file` / `list_dir` | Inside the roots. Reads support inclusive line ranges and default to 32 KiB per page. Directories return the first 500 sorted entries and report truncation. Read-only. |
| `search_files` | Literal text lookup with an optional filename glob. Skips hidden paths and symlinks. Read-only. |
| `git_status` | Fixed `git status --porcelain`. Requires the `status` allowlist entry. Read-only. |
| `git_diff` / `git_log` | Unstaged changes by default, staged changes on request, and recent commit history. Read-only. |
| `kill_job` | Cancel a running command on the selected machine. Destructive. |
| `write_file` / `apply_patch` | Inside the roots. Unified diffs. Destructive. |
| `git_commit_push` | Named paths, branch allowlist, push only if `git.push` is true. Destructive. |

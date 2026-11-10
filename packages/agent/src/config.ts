import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { MACHINE_NAME, MIN_TOKEN_LENGTH } from "grokcode-shared";

export interface AgentConfig {
  name: string;
  relay?: string;
  token?: string;
  listen?: string;
  mcpToken?: string;
  opencodeUrl?: string;
  spawn: boolean;
  opencodeBin: string;
  opencodeHostname: string;
  opencodePort: number;
  allowDirs: string[];
  maxSyncWaitMs: number;
  verbose: boolean;
  password?: string;
  username: string;
  help: boolean;
  version: boolean;
}

export const HELP = `grokcode-agent — connect a local OpenCode server to Grok Bot

Relay (default architecture, no inbound ports):
  grokcode-agent --name laptop --relay wss://YOUR_WORKER.workers.dev/agent

Direct / Tailscale (no Cloudflare):
  grokcode-agent --listen 127.0.0.1:8788

Both at once:
  grokcode-agent --name laptop --relay wss://YOUR_WORKER.workers.dev/agent --listen 127.0.0.1:8788

Options:
  --name <name>              Machine name (required with --relay; default "local")
  --relay <url>              Relay WebSocket URL (wss://…/agent, or https://… )
  --token <token>            Per-machine token (or GROKCODE_MACHINE_TOKEN)
  --listen <host:port>       Serve MCP over HTTP for Tailscale or a private network
  --mcp-token <token>        Bearer token for --listen (or GROKCODE_MCP_TOKEN)
  --opencode-url <url>       Attach to an existing server (default: spawn opencode serve)
  --spawn                    Start opencode serve even if a URL is set
  --no-spawn                 Never start opencode; only attach
  --opencode-bin <path>      OpenCode executable (default: opencode)
  --opencode-hostname <host> Bind address for a spawned server (default: 127.0.0.1)
  --opencode-port <port>     Port for a spawned server (default: 4096)
  --allow-dir <path>         Absolute directory OpenCode may use (repeatable)
  --sync-wait-ms <ms>        Cap for wait=true / wait_session (default 20000, max 25000)
  --config <file>            JSON config file. Tokens still belong in the environment.
  --verbose
  --help
  --version

Environment:
  GROKCODE_MACHINE_NAME, GROKCODE_RELAY_URL, GROKCODE_MACHINE_TOKEN
  GROKCODE_LISTEN, GROKCODE_MCP_TOKEN, GROKCODE_OPENCODE_URL
  GROKCODE_ALLOW_DIRS (comma-separated), GROKCODE_OPENCODE_BIN
  OPENCODE_PASSWORD or OPENCODE_SERVER_PASSWORD, OPENCODE_SERVER_USERNAME
`;

interface FileConfig {
  name?: string;
  relay?: string;
  listen?: string;
  opencodeUrl?: string;
  spawn?: boolean;
  opencodeBin?: string;
  opencodeHostname?: string;
  opencodePort?: number;
  allowDirs?: string[];
  maxSyncWaitMs?: number;
  verbose?: boolean;
  username?: string;
}

function envString(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  if (value == null) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function splitDirs(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(/[,;]/).map((part) => part.trim()).filter(Boolean);
}

export function parseListen(value: string): { host: string; port: number } {
  if (/^\d+$/.test(value)) return { host: "127.0.0.1", port: Number(value) };
  const ipv6 = /^\[([^\]]+)\]:(\d+)$/.exec(value);
  if (ipv6) return { host: ipv6[1]!, port: Number(ipv6[2]) };
  const idx = value.lastIndexOf(":");
  if (idx <= 0) throw new Error(`Invalid --listen "${value}". Use host:port or a port.`);
  const port = Number(value.slice(idx + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port in --listen "${value}".`);
  }
  return { host: value.slice(0, idx), port };
}

export function relayWebSocketUrl(input: string): string {
  const url = new URL(input);
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("Relay URL must start with ws://, wss://, http://, or https://.");
  }
  if (url.pathname === "/" || url.pathname === "") url.pathname = "/agent";
  return url.toString();
}

export function loadConfig(argv: string[], env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const { values } = parseArgs({
    args: argv,
    options: {
      name: { type: "string" },
      relay: { type: "string" },
      token: { type: "string" },
      listen: { type: "string" },
      "mcp-token": { type: "string" },
      "opencode-url": { type: "string" },
      spawn: { type: "boolean" },
      "no-spawn": { type: "boolean" },
      "opencode-bin": { type: "string" },
      "opencode-hostname": { type: "string" },
      "opencode-port": { type: "string" },
      "allow-dir": { type: "string", multiple: true },
      "sync-wait-ms": { type: "string" },
      config: { type: "string" },
      verbose: { type: "boolean" },
      help: { type: "boolean" },
      version: { type: "boolean" },
    },
    strict: true,
    allowPositionals: false,
  });

  let file: FileConfig = {};
  if (values.config) {
    const parsed = JSON.parse(readFileSync(values.config, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("--config must be a JSON object.");
    }
    file = parsed as FileConfig;
  }

  const password = envString(env, "OPENCODE_PASSWORD") ?? envString(env, "OPENCODE_SERVER_PASSWORD");
  const username = envString(env, "OPENCODE_SERVER_USERNAME") ?? file.username ?? "opencode";
  const allowDirs = [
    ...(file.allowDirs ?? []),
    ...splitDirs(envString(env, "GROKCODE_ALLOW_DIRS")),
    ...(values["allow-dir"] ?? []),
  ];

  const opencodeUrl = values["opencode-url"] ?? envString(env, "GROKCODE_OPENCODE_URL") ?? file.opencodeUrl;
  let spawn = file.spawn ?? !opencodeUrl;
  if (env.GROKCODE_SPAWN === "0") spawn = false;
  if (env.GROKCODE_SPAWN === "1") spawn = true;
  if (values["no-spawn"]) spawn = false;
  if (values.spawn) spawn = true;

  const relay = values.relay ?? envString(env, "GROKCODE_RELAY_URL") ?? file.relay;
  const listen = values.listen ?? envString(env, "GROKCODE_LISTEN") ?? file.listen;
  const name = values.name ?? envString(env, "GROKCODE_MACHINE_NAME") ?? file.name ?? "local";
  const token = values.token ?? envString(env, "GROKCODE_MACHINE_TOKEN");
  const mcpToken = values["mcp-token"] ?? envString(env, "GROKCODE_MCP_TOKEN");
  const maxSyncWaitMs = Number(values["sync-wait-ms"] ?? file.maxSyncWaitMs ?? 20_000);
  const opencodePort = Number(values["opencode-port"] ?? file.opencodePort ?? 4096);

  return {
    name,
    ...(relay ? { relay: relayWebSocketUrl(relay) } : {}),
    ...(token ? { token } : {}),
    ...(listen ? { listen } : {}),
    ...(mcpToken ? { mcpToken } : {}),
    ...(opencodeUrl ? { opencodeUrl } : {}),
    spawn,
    opencodeBin: values["opencode-bin"] ?? envString(env, "GROKCODE_OPENCODE_BIN") ?? file.opencodeBin ?? "opencode",
    opencodeHostname: values["opencode-hostname"] ?? file.opencodeHostname ?? "127.0.0.1",
    opencodePort,
    allowDirs,
    maxSyncWaitMs: Number.isFinite(maxSyncWaitMs) ? maxSyncWaitMs : 20_000,
    verbose: values.verbose === true || file.verbose === true || env.GROKCODE_VERBOSE === "1",
    ...(password ? { password } : {}),
    username,
    help: values.help === true,
    version: values.version === true,
  };
}

export function validateConfig(config: AgentConfig): void {
  if (config.help || config.version) return;
  if (!config.relay && !config.listen) {
    throw new Error("Pass --relay, --listen, or both. Run grokcode-agent --help.");
  }
  if (!MACHINE_NAME.test(config.name)) {
    throw new Error("Machine name must match [A-Za-z0-9][A-Za-z0-9_.-]{0,63}.");
  }
  if (config.relay) {
    if (!config.token || config.token.length < MIN_TOKEN_LENGTH) {
      throw new Error(
        `Relay mode needs a per-machine token of at least ${MIN_TOKEN_LENGTH} characters (--token or GROKCODE_MACHINE_TOKEN).`,
      );
    }
  }
  if (config.listen) {
    parseListen(config.listen);
    if (!config.mcpToken || config.mcpToken.length < MIN_TOKEN_LENGTH) {
      throw new Error(
        `Direct mode needs an MCP bearer token of at least ${MIN_TOKEN_LENGTH} characters (--mcp-token or GROKCODE_MCP_TOKEN).`,
      );
    }
  }
  if (!Number.isInteger(config.opencodePort) || config.opencodePort < 1 || config.opencodePort > 65535) {
    throw new Error("--opencode-port must be a TCP port.");
  }
}

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { MACHINE_NAME, MIN_TOKEN_LENGTH } from "grokcode-shared";

import { assertModelId, parseEnvFile } from "./envfile.js";
import type { ForeignPolicy, OpenCodeMode } from "./ownership.js";

export interface AgentConfig {
  name: string;
  relay?: string;
  token?: string;
  listen?: string;
  mcpToken?: string;
  opencodeUrl?: string;
  /** True when the agent may start opencode serve (auto or spawn). */
  spawn: boolean;
  opencodeMode: OpenCodeMode;
  opencodeOnForeign?: ForeignPolicy;
  opencodeBin: string;
  opencodeHostname: string;
  opencodePort: number;
  allowDirs: string[];
  maxSyncWaitMs: number;
  verbose: boolean;
  password?: string;
  username: string;
  defaultModel?: string;
  /** Directory that holds agent.env and the OpenCode pid file. */
  configDir?: string;
  loadedFrom: string[];
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

The agent reads ~/.config/grokcode/agent.env and agent.json on its own
(%USERPROFILE%\\.config\\grokcode on Windows). --config and GROKCODE_CONFIG
select a file or a directory. Real environment variables override the file.
CLI flags override both.

Options:
  --name <name>              Machine name (required with --relay; default "local")
  --relay <url>              Relay WebSocket URL (wss://…/agent, or https://… )
  --token <token>            Per-machine token (or GROKCODE_MACHINE_TOKEN)
  --listen <host:port>       Serve MCP over HTTP for Tailscale or a private network
  --mcp-token <token>        Bearer token for --listen (or GROKCODE_MCP_TOKEN)
  --opencode-url <url>       Attach to an existing server
  --opencode-mode <mode>     spawn, attach, or auto (default auto)
  --on-foreign <policy>      attach, replace, or next-port when a server is already running
  --spawn                    Own the OpenCode process (mode spawn)
  --no-spawn                 Never start opencode; only attach (mode attach)
  --opencode-bin <path>      OpenCode executable (default: opencode)
  --opencode-hostname <host> Bind address for a spawned server (default: 127.0.0.1)
  --opencode-port <port>     Port for a spawned server (default: 4096)
  --default-model <model>    provider/model used when a caller omits model
  --allow-dir <path>         Absolute directory OpenCode may use (repeatable)
  --sync-wait-ms <ms>        Cap for wait=true / wait_session (default 20000, max 25000)
  --config <file>            agent.env or agent.json. Tokens may live in this file.
  --verbose
  --help
  --version

Environment:
  GROKCODE_MACHINE_NAME, GROKCODE_RELAY_URL, GROKCODE_MACHINE_TOKEN
  GROKCODE_LISTEN, GROKCODE_MCP_TOKEN, GROKCODE_OPENCODE_URL
  GROKCODE_ALLOW_DIRS (comma-separated), GROKCODE_OPENCODE_BIN
  GROKCODE_DEFAULT_MODEL, GROKCODE_OPENCODE_MODE, GROKCODE_OPENCODE_ON_FOREIGN
  GROKCODE_CONFIG
  OPENCODE_PASSWORD or OPENCODE_SERVER_PASSWORD, OPENCODE_SERVER_USERNAME
`;

export interface FileConfig {
  name?: string;
  relay?: string;
  token?: string;
  listen?: string;
  mcpToken?: string;
  opencodeUrl?: string;
  spawn?: boolean;
  opencodeMode?: OpenCodeMode;
  opencodeOnForeign?: ForeignPolicy;
  opencodeBin?: string;
  opencodeHostname?: string;
  opencodePort?: number;
  allowDirs?: string[];
  maxSyncWaitMs?: number;
  verbose?: boolean;
  username?: string;
  password?: string;
  defaultModel?: string;
}

export function homeFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const userProfile = env.USERPROFILE?.trim();
  const home = env.HOME?.trim();
  if (process.platform === "win32" && userProfile) return userProfile;
  return home || userProfile || undefined;
}

export function defaultConfigDir(env: NodeJS.ProcessEnv): string | undefined {
  const home = homeFromEnv(env);
  if (!home) return undefined;
  return path.join(home, ".config", "grokcode");
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

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function asBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function asMode(value: unknown): OpenCodeMode | undefined {
  const text = asString(value);
  if (!text) return undefined;
  if (text === "auto" || text === "attach" || text === "spawn") return text;
  throw new Error(`GROKCODE_OPENCODE_MODE must be auto, attach, or spawn. Got "${text}".`);
}

function asForeign(value: unknown): ForeignPolicy | undefined {
  const text = asString(value);
  if (!text) return undefined;
  if (text === "attach" || text === "replace" || text === "next-port") return text;
  throw new Error(`GROKCODE_OPENCODE_ON_FOREIGN must be attach, replace, or next-port. Got "${text}".`);
}

function asDirs(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  const text = asString(value);
  if (!text) return undefined;
  return splitDirs(text);
}

export function fileConfigFromPairs(pairs: Record<string, unknown>): FileConfig {
  const pick = (...keys: string[]): unknown => {
    for (const key of keys) {
      if (pairs[key] != null && pairs[key] !== "") return pairs[key];
    }
    return undefined;
  };
  const config: FileConfig = {};
  const name = asString(pick("name", "GROKCODE_MACHINE_NAME"));
  const relay = asString(pick("relay", "GROKCODE_RELAY_URL"));
  const token = asString(pick("token", "GROKCODE_MACHINE_TOKEN"));
  const listen = asString(pick("listen", "GROKCODE_LISTEN"));
  const mcpToken = asString(pick("mcpToken", "GROKCODE_MCP_TOKEN"));
  const opencodeUrl = asString(pick("opencodeUrl", "GROKCODE_OPENCODE_URL"));
  const opencodeBin = asString(pick("opencodeBin", "GROKCODE_OPENCODE_BIN"));
  const opencodeHostname = asString(pick("opencodeHostname"));
  const username = asString(pick("username", "OPENCODE_SERVER_USERNAME"));
  const password = asString(pick("password", "OPENCODE_PASSWORD", "OPENCODE_SERVER_PASSWORD"));
  const defaultModel = asString(pick("defaultModel", "GROKCODE_DEFAULT_MODEL"));
  const allowDirs = asDirs(pick("allowDirs", "GROKCODE_ALLOW_DIRS"));
  const spawn = asBool(pick("spawn", "GROKCODE_SPAWN"));
  const verbose = asBool(pick("verbose", "GROKCODE_VERBOSE"));
  const opencodePort = asNumber(pick("opencodePort"));
  const maxSyncWaitMs = asNumber(pick("maxSyncWaitMs"));
  const opencodeMode = asMode(pick("opencodeMode", "GROKCODE_OPENCODE_MODE"));
  const opencodeOnForeign = asForeign(pick("opencodeOnForeign", "GROKCODE_OPENCODE_ON_FOREIGN"));
  if (name) config.name = name;
  if (relay) config.relay = relay;
  if (token) config.token = token;
  if (listen) config.listen = listen;
  if (mcpToken) config.mcpToken = mcpToken;
  if (opencodeUrl) config.opencodeUrl = opencodeUrl;
  if (opencodeBin) config.opencodeBin = opencodeBin;
  if (opencodeHostname) config.opencodeHostname = opencodeHostname;
  if (username) config.username = username;
  if (password) config.password = password;
  if (defaultModel) config.defaultModel = defaultModel;
  if (allowDirs) config.allowDirs = allowDirs;
  if (spawn !== undefined) config.spawn = spawn;
  if (verbose !== undefined) config.verbose = verbose;
  if (opencodePort !== undefined) config.opencodePort = opencodePort;
  if (maxSyncWaitMs !== undefined) config.maxSyncWaitMs = maxSyncWaitMs;
  if (opencodeMode) config.opencodeMode = opencodeMode;
  if (opencodeOnForeign) config.opencodeOnForeign = opencodeOnForeign;
  return config;
}

export function readConfigFile(file: string): FileConfig {
  const text = readFileSync(file, "utf8");
  const ext = path.extname(file).toLowerCase();
  if (ext === ".json" || (ext !== ".env" && text.trim().startsWith("{"))) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`Could not parse ${file} as JSON.`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${file} must contain a JSON object.`);
    }
    return fileConfigFromPairs(parsed as Record<string, unknown>);
  }
  return fileConfigFromPairs(parseEnvFile(text));
}

function mergeFile(base: FileConfig, extra: FileConfig): FileConfig {
  return {
    ...base,
    ...extra,
    allowDirs: [...(base.allowDirs ?? []), ...(extra.allowDirs ?? [])],
  };
}

export function configSources(env: NodeJS.ProcessEnv, cliConfig: string | undefined): string[] {
  if (cliConfig) return [path.resolve(cliConfig)];
  const selected = envString(env, "GROKCODE_CONFIG");
  if (selected) {
    const resolved = path.resolve(selected);
    if (!existsSync(resolved)) throw new Error(`Config path not found: ${resolved}`);
    if (statSync(resolved).isDirectory()) {
      return ["agent.json", "agent.env"]
        .map((name) => path.join(resolved, name))
        .filter((file) => existsSync(file));
    }
    return [resolved];
  }
  const dir = defaultConfigDir(env);
  if (!dir) return [];
  return ["agent.json", "agent.env"].map((name) => path.join(dir, name)).filter((file) => existsSync(file));
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
      "opencode-mode": { type: "string" },
      "on-foreign": { type: "string" },
      spawn: { type: "boolean" },
      "no-spawn": { type: "boolean" },
      "opencode-bin": { type: "string" },
      "opencode-hostname": { type: "string" },
      "opencode-port": { type: "string" },
      "default-model": { type: "string" },
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

  const loadedFrom = configSources(env, values.config);
  let file: FileConfig = {};
  for (const source of loadedFrom) {
    if (!existsSync(source)) throw new Error(`Config file not found: ${source}`);
    file = mergeFile(file, readConfigFile(source));
  }

  const password = envString(env, "OPENCODE_PASSWORD") ?? envString(env, "OPENCODE_SERVER_PASSWORD") ?? file.password;
  const username = envString(env, "OPENCODE_SERVER_USERNAME") ?? file.username ?? "opencode";
  const allowDirs = [
    ...(file.allowDirs ?? []),
    ...splitDirs(envString(env, "GROKCODE_ALLOW_DIRS")),
    ...(values["allow-dir"] ?? []),
  ];

  const opencodeUrl = values["opencode-url"] ?? envString(env, "GROKCODE_OPENCODE_URL") ?? file.opencodeUrl;
  const relay = values.relay ?? envString(env, "GROKCODE_RELAY_URL") ?? file.relay;
  const listen = values.listen ?? envString(env, "GROKCODE_LISTEN") ?? file.listen;
  const name = values.name ?? envString(env, "GROKCODE_MACHINE_NAME") ?? file.name ?? "local";
  const token = values.token ?? envString(env, "GROKCODE_MACHINE_TOKEN") ?? file.token;
  const mcpToken = values["mcp-token"] ?? envString(env, "GROKCODE_MCP_TOKEN") ?? file.mcpToken;
  const maxSyncWaitMs = Number(values["sync-wait-ms"] ?? envString(env, "GROKCODE_SYNC_WAIT_MS") ?? file.maxSyncWaitMs ?? 20_000);
  const opencodePort = Number(values["opencode-port"] ?? envString(env, "GROKCODE_OPENCODE_PORT") ?? file.opencodePort ?? 4096);
  const defaultModel = values["default-model"] ?? envString(env, "GROKCODE_DEFAULT_MODEL") ?? file.defaultModel;

  if (values.spawn && values["no-spawn"]) throw new Error("Pass only one of --spawn and --no-spawn.");
  let opencodeMode =
    asMode(values["opencode-mode"]) ??
    asMode(envString(env, "GROKCODE_OPENCODE_MODE")) ??
    file.opencodeMode;
  const onForeign = asForeign(values["on-foreign"]) ?? asForeign(envString(env, "GROKCODE_OPENCODE_ON_FOREIGN")) ?? file.opencodeOnForeign;
  if (values["no-spawn"]) opencodeMode = "attach";
  else if (values.spawn) opencodeMode = "spawn";
  else if (!opencodeMode) {
    const spawnOff = env.GROKCODE_SPAWN === "0" || (env.GROKCODE_SPAWN !== "1" && file.spawn === false);
    opencodeMode = spawnOff || opencodeUrl ? "attach" : "auto";
  }

  const configDir = loadedFrom[0] ? path.dirname(loadedFrom[0]) : defaultConfigDir(env);

  return {
    name,
    ...(relay ? { relay: relayWebSocketUrl(relay) } : {}),
    ...(token ? { token } : {}),
    ...(listen ? { listen } : {}),
    ...(mcpToken ? { mcpToken } : {}),
    ...(opencodeUrl ? { opencodeUrl } : {}),
    spawn: opencodeMode !== "attach",
    opencodeMode,
    ...(onForeign ? { opencodeOnForeign: onForeign } : {}),
    opencodeBin: values["opencode-bin"] ?? envString(env, "GROKCODE_OPENCODE_BIN") ?? file.opencodeBin ?? "opencode",
    opencodeHostname: values["opencode-hostname"] ?? file.opencodeHostname ?? "127.0.0.1",
    opencodePort,
    allowDirs,
    maxSyncWaitMs: Number.isFinite(maxSyncWaitMs) ? maxSyncWaitMs : 20_000,
    verbose: values.verbose === true || file.verbose === true || env.GROKCODE_VERBOSE === "1",
    ...(password ? { password } : {}),
    username,
    ...(defaultModel ? { defaultModel } : {}),
    ...(configDir ? { configDir } : {}),
    loadedFrom,
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
        `Relay mode needs a per-machine token of at least ${MIN_TOKEN_LENGTH} characters (--token, GROKCODE_MACHINE_TOKEN, or the config file).`,
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
  if (config.defaultModel) assertModelId(config.defaultModel, "GROKCODE_DEFAULT_MODEL");
}

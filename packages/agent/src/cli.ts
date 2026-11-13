#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import path from "node:path";

import { HELP, loadConfig, parseListen, validateConfig, type AgentConfig } from "./config.js";
import { ensureOpenCode } from "./ownership.js";
import { runRelayConnection } from "./relay.js";
import { listenDirect } from "./server.js";
import { createOpenCodeService } from "./service.js";
import { probeOpenCode } from "./supervisor.js";
import { executeOp, type OpenCodeClient } from "grokcode-shared";

const VERSION = "0.1.0";

interface Io {
  log: (line: string) => void;
  error: (line: string) => void;
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export async function run(argv: string[], env: NodeJS.ProcessEnv, io: Io, signal: AbortSignal): Promise<number> {
  let config: AgentConfig;
  try {
    config = loadConfig(argv, env);
    validateConfig(config);
  } catch (err) {
    io.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
  if (config.help) {
    io.log(HELP);
    return 0;
  }
  if (config.version) {
    io.log(VERSION);
    return 0;
  }

  if (config.loadedFrom.length > 0) io.log(`Loaded config from ${config.loadedFrom.join(", ")}.`);
  io.log(`OpenCode mode ${config.opencodeMode} (${config.opencodeModeSource}).`);
  if (config.defaultModel) io.log(`Default model ${config.defaultModel}.`);
  if (config.opencodeUrl && config.opencodeMode === "spawn") {
    io.log("Ignoring --opencode-url because OpenCode mode is spawn.");
  }

  const attachUrl = config.opencodeMode === "spawn" ? undefined : config.opencodeUrl;
  const endpoint = attachUrl
    ? endpointOf(attachUrl, config.opencodeHostname, config.opencodePort)
    : { host: config.opencodeHostname, port: config.opencodePort };
  let ensured;
  try {
    ensured = await ensureOpenCode({
      mode: config.opencodeMode,
      ...(config.opencodeOnForeign ? { onForeign: config.opencodeOnForeign } : {}),
      host: endpoint.host,
      port: endpoint.port,
      command: config.opencodeBin,
      ...(config.password ? { password: config.password } : {}),
      env,
      signal,
      verbose: config.verbose,
      pidFile: path.join(config.configDir ?? ".grokcode", "opencode.pid"),
      ...(attachUrl ? { attachUrl } : {}),
      log: (line) => io.log(line),
      deps: {
        probe: (url, password) =>
          probeOpenCode(url, { username: config.username, ...(password ? { password } : {}) }),
      },
    });
  } catch (err) {
    io.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const served = endpointOf(ensured.baseUrl, endpoint.host, endpoint.port);
  const password = ensured.password();
  const service = createOpenCodeService({
    baseUrl: ensured.baseUrl,
    host: served.host,
    port: served.port,
    command: config.opencodeBin,
    username: config.username,
    ...(password ? { password } : {}),
    env,
    pidFile: path.join(config.configDir ?? ".grokcode", "opencode.pid"),
    signal,
    log: (line) => io.log(line),
  });
  service.watch();
  const stopChild = ensured.stop;
  const getApi = () => service.getClient();

  const execute = async (op: string, params: unknown) => {
    const shared = {
      allowDirs: config.allowDirs,
      opencodeControl: service.control,
      ...(config.defaultModel ? { defaultModel: config.defaultModel } : {}),
    };
    if (op === "opencode_status" || op === "start_opencode") {
      return executeOp(shared, op, params);
    }
    const api = await getApi();
    return executeOp({ ...shared, api }, op, params);
  };

  const closers: Array<() => Promise<void>> = [stopChild];
  if (config.listen && config.mcpToken) {
    const { host, port } = parseListen(config.listen);
    const listening = await listenDirect({
      host,
      port,
      name: config.name,
      mcpToken: config.mcpToken,
      allowDirs: config.allowDirs,
      maxSyncWaitMs: config.maxSyncWaitMs,
      ...(config.defaultModel ? { defaultModel: config.defaultModel } : {}),
      getApi,
      opencodeControl: service.control,
    });
    io.log(`Direct MCP at ${listening.url}/mcp (Authorization: Bearer <mcp token>).`);
    closers.push(listening.close);
  }

  const tasks: Promise<void>[] = [];
  if (config.relay && config.token) {
    io.log(`Dialing relay ${config.relay} as ${config.name}.`);
    tasks.push(relayLoop(config.relay, config.name, config.token, execute, signal, getApi, io, config.verbose));
  }

  const aborted = new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });

  if (tasks.length === 0) {
    await aborted;
  } else {
    await Promise.race([aborted, Promise.all(tasks).then(() => undefined)]);
  }
  await Promise.all(closers.map((close) => close().catch(() => undefined)));
  return 0;
}

async function relayLoop(
  url: string,
  name: string,
  token: string,
  execute: (op: string, params: unknown) => Promise<unknown>,
  signal: AbortSignal,
  getApi: () => Promise<OpenCodeClient>,
  io: Io,
  verbose: boolean,
): Promise<void> {
  let delay = 1000;
  while (!signal.aborted) {
    let meta: { api?: "v1" | "v2"; version?: string } | undefined;
    try {
      const api = await getApi();
      meta = { api: api.api, ...(api.version ? { version: api.version } : {}) };
    } catch {
      meta = undefined;
    }
    try {
      await runRelayConnection({ url, name, token, execute, signal, ...(meta ? { opencode: meta } : {}) });
      delay = 1000;
      if (verbose && !signal.aborted) io.log("Relay socket closed. Reconnecting.");
    } catch (err) {
      if (signal.aborted) break;
      const message = err instanceof Error ? err.message : String(err);
      io.error(`Relay connection failed: ${message}`);
    }
    if (signal.aborted) break;
    await sleep(delay, signal);
    delay = Math.min(delay * 2, 30_000);
  }
}

function endpointOf(url: string, fallbackHost: string, fallbackPort: number): { host: string; port: number } {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname || fallbackHost,
      port: parsed.port ? Number(parsed.port) : fallbackPort,
    };
  } catch {
    return { host: fallbackHost, port: fallbackPort };
  }
}

function installSignalHandlers(controller: AbortController): void {
  const stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

const invokedDirectly = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const controller = new AbortController();
  installSignalHandlers(controller);
  run(process.argv.slice(2), process.env, { log: (line) => console.log(line), error: (line) => console.error(line) }, controller.signal)
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}

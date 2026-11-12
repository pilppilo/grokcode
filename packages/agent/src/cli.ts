#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import { HELP, loadConfig, parseListen, validateConfig, type AgentConfig } from "./config.js";
import { runRelayConnection } from "./relay.js";
import { listenDirect } from "./server.js";
import { buildServeArgs, probeOpenCode, supervise } from "./supervisor.js";
import {
  detectOpenCode,
  executeOp,
  type OpenCodeAuth,
  type OpenCodeClient,
} from "grokcode-shared";

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

  const auth: OpenCodeAuth = {
    username: config.username,
    ...(config.password ? { password: config.password } : {}),
  };
  const baseUrl = config.opencodeUrl ?? `http://${config.opencodeHostname}:${config.opencodePort}`;
  let stopChild = async () => {};

  if (!config.spawn) {
    const state = await probeOpenCode(baseUrl, auth);
    if (state === "down") {
      io.error(`OpenCode is not reachable at ${baseUrl}. Start it, or drop --no-spawn so the agent can launch \`opencode serve\`.`);
      return 1;
    }
    if (state === "unauthorized") {
      io.error("OpenCode rejected the password. Set OPENCODE_PASSWORD (username is opencode).");
      return 1;
    }
  } else {
    const hostname = config.opencodeHostname;
    const port = config.opencodePort;
    if (!config.opencodeUrl) {
      const existing = await probeOpenCode(baseUrl, auth);
      if (existing === "unauthorized") {
        io.error(`Something is already serving ${baseUrl} and rejected the password. Set OPENCODE_PASSWORD or change --opencode-port.`);
        return 1;
      }
      if (existing === "up") {
        io.log(`Attaching to OpenCode already running at ${baseUrl}.`);
      } else {
        io.log(`Starting opencode serve on ${baseUrl}.`);
        try {
          const supervised = await supervise({
            command: config.opencodeBin,
            args: buildServeArgs(hostname, port),
            env,
            shell: process.platform === "win32",
            password: config.password,
            signal,
            log: (line) => {
              if (config.verbose) io.log(line);
            },
            probe: (password) =>
              probeOpenCode(baseUrl, { username: config.username, ...(password ? { password } : {}) }),
          });
          if (supervised.password() && !auth.password) auth.password = supervised.password();
          stopChild = supervised.stop;
        } catch (err) {
          io.error(err instanceof Error ? err.message : String(err));
          return 1;
        }
      }
    } else {
      io.log(`Spawning is ignored because --opencode-url is set (${baseUrl}). Use a separate \`opencode serve\` or omit the URL.`);
    }
  }

  let apiPromise: Promise<OpenCodeClient> | undefined;
  const getApi = () => {
    if (!apiPromise) {
      apiPromise = detectOpenCode({ baseUrl, auth, timeoutMs: 8000 }).catch((err) => {
        apiPromise = undefined;
        throw err;
      });
    }
    return apiPromise;
  };

  const execute = async (op: string, params: unknown) => {
    const api = await getApi();
    return executeOp({ api, allowDirs: config.allowDirs }, op, params);
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
      getApi,
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

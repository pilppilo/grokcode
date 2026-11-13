import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { buildServeArgs, supervise, type ProbeResult, type SuperviseOptions, type SupervisedProcess } from "./supervisor.js";
import { isPidAlive, killProcessTree, listeningPid, portAvailable } from "./ports.js";

export type OpenCodeMode = "auto" | "attach" | "spawn";
export type ForeignPolicy = "attach" | "replace" | "next-port";

export interface PidRecord {
  listenerPid?: number;
  spawnPid?: number;
  host: string;
  port: number;
  /** Started by start_opencode. The agent must not kill or restart this process. */
  detached?: boolean;
}

export interface AssessInput {
  mode: OpenCodeMode;
  onForeign?: ForeignPolicy;
  host: string;
  port: number;
  listenerPid?: number;
  probe: ProbeResult;
  record?: PidRecord;
  recordAlive: boolean;
  recordProbe?: ProbeResult;
}

export type AssessAction =
  | { type: "attach"; owned: boolean; host: string; port: number; pid?: number; message: string }
  | { type: "wait"; host: string; port: number; message: string }
  | { type: "spawn"; host: string; port: number; message: string; stopPids: number[] }
  | { type: "spawn-next"; host: string; message: string; stopPids: number[] }
  | { type: "replace"; host: string; port: number; pid: number; message: string; stopPids: number[] }
  | { type: "fail"; message: string };

function assessAttach(input: AssessInput): AssessAction {
  const { host, port, probe, listenerPid } = input;
  if (probe === "up") {
    const pidNote = listenerPid ? ` (pid ${listenerPid})` : "";
    return {
      type: "attach",
      owned: false,
      host,
      port,
      ...(listenerPid ? { pid: listenerPid } : {}),
      message: `Attaching to OpenCode at ${origin(host, port)}${pidNote}. This agent did not take ownership of it and will not stop it.`,
    };
  }
  if (probe === "unauthorized") {
    return {
      type: "wait",
      host,
      port,
      message: `OpenCode at ${origin(host, port)} rejected OPENCODE_PASSWORD. The agent will keep retrying and will not start or stop a server.`,
    };
  }
  return {
    type: "wait",
    host,
    port,
    message: `OpenCode is not reachable at ${origin(host, port)}. The agent will keep retrying. It will not start a server unless start_opencode is called.`,
  };
}

function origin(host: string, port: number): string {
  return `http://${host}:${port}`;
}

function elsewherePid(input: AssessInput): number | undefined {
  const record = input.record;
  if (!record || !input.recordAlive) return undefined;
  if (record.host === input.host && record.port === input.port) return undefined;
  return record.listenerPid ?? record.spawnPid;
}

/**
 * Decide what to do with a port that may already have an OpenCode server.
 * `auto` attaches when the password is accepted and otherwise moves to another port.
 * `spawn` owns a process, replacing a foreign server unless told to pick another port.
 * `attach` never kills and never starts a server. A down server is waited on, not failed closed.
 * A server recorded as detached (start_opencode) is never killed or replaced.
 */
export function assessOpenCode(input: AssessInput): AssessAction {
  const { mode, host, port, probe, listenerPid, record } = input;
  if (mode === "attach") return assessAttach(input);
  if (record?.detached && listenerPid && record.host === host && record.port === port && (record.listenerPid === listenerPid || record.spawnPid === listenerPid)) {
    if (probe === "up") {
      return {
        type: "attach",
        owned: false,
        host,
        port,
        pid: listenerPid,
        message: `OpenCode at ${origin(host, port)} (pid ${listenerPid}) was started on request. This agent will not stop it.`,
      };
    }
    return {
      type: "fail",
      message: `OpenCode pid ${listenerPid} was started on request and is not healthy at ${origin(host, port)}. This agent will not stop it.`,
    };
  }
  const policy: ForeignPolicy | undefined = input.onForeign ?? (mode === "spawn" ? "replace" : undefined);
  const matchesRecord =
    !!listenerPid &&
    !!record &&
    record.host === host &&
    record.port === port &&
    (record.listenerPid === listenerPid || record.spawnPid === listenerPid);
  const oldPid = elsewherePid(input);
  const stopElsewhere = oldPid ? [oldPid] : [];

  if (
    record &&
    input.recordAlive &&
    record.port !== port &&
    input.recordProbe === "up" &&
    policy !== "replace"
  ) {
    const pid = record.listenerPid ?? record.spawnPid;
    if (record.detached) {
      return {
        type: "attach",
        owned: false,
        host: record.host,
        port: record.port,
        ...(pid ? { pid } : {}),
        message: `OpenCode at ${origin(record.host, record.port)} (pid ${pid ?? "unknown"}) was started on request. This agent will not stop it.`,
      };
    }
    return {
      type: "attach",
      owned: true,
      host: record.host,
      port: record.port,
      ...(pid ? { pid } : {}),
      message: `Reusing OpenCode this agent started (pid ${pid ?? "unknown"}) at ${origin(record.host, record.port)}.`,
    };
  }

  if (!listenerPid && probe === "down") {
    return {
      type: "spawn",
      host,
      port,
      message: `Starting opencode serve on ${origin(host, port)}.`,
      stopPids: stopElsewhere,
    };
  }

  if (matchesRecord && probe === "up") {
    return {
      type: "attach",
      owned: true,
      host,
      port,
      ...(listenerPid ? { pid: listenerPid } : {}),
      message: `Reusing OpenCode this agent started (pid ${listenerPid}) at ${origin(host, port)}.`,
    };
  }

  if (matchesRecord && listenerPid) {
    return {
      type: "replace",
      host,
      port,
      pid: listenerPid,
      message: `Replacing OpenCode this agent started (pid ${listenerPid}) at ${origin(host, port)} because it is not accepting the configured password.`,
      stopPids: stopElsewhere.filter((pid) => pid !== listenerPid),
    };
  }

  const foreignPid = listenerPid;
  const passwordOk = probe === "up";
  const attachForeign = policy === "attach" || (mode === "auto" && !input.onForeign && passwordOk);
  if (attachForeign) {
    if (passwordOk) {
      const pidNote = foreignPid ? ` (pid ${foreignPid})` : "";
      return {
        type: "attach",
        owned: false,
        host,
        port,
        ...(foreignPid ? { pid: foreignPid } : {}),
        message: `Attaching to OpenCode at ${origin(host, port)}${pidNote}. This agent did not start it. Password accepted. It will not be stopped when the agent exits.`,
      };
    }
    if (probe === "unauthorized") {
      return {
        type: "fail",
        message: `OpenCode at ${origin(host, port)} rejected OPENCODE_PASSWORD. Refusing to attach. Set the password, or set GROKCODE_OPENCODE_MODE=spawn or GROKCODE_OPENCODE_ON_FOREIGN=replace|next-port.`,
      };
    }
    return { type: "fail", message: `OpenCode is not reachable at ${origin(host, port)}.` };
  }

  const move = policy === "next-port" || (mode === "auto" && !input.onForeign && !passwordOk);
  if (move) {
    const why =
      probe === "unauthorized"
        ? `OpenCode on ${host}:${port} rejected OPENCODE_PASSWORD. Starting a separate server on another port.`
        : `Port ${port} is in use by a server this agent did not start. Starting opencode serve on another port.`;
    return { type: "spawn-next", host, message: why, stopPids: stopElsewhere };
  }

  if (!foreignPid) {
    return {
      type: "spawn-next",
      host,
      message: `Something is listening on ${host}:${port} but its pid could not be identified, so it was not killed. Starting opencode serve on another port.`,
      stopPids: stopElsewhere,
    };
  }
  return {
    type: "replace",
    host,
    port,
    pid: foreignPid,
    message: `Replacing the OpenCode server this agent did not start (pid ${foreignPid}) on ${origin(host, port)}.`,
    stopPids: stopElsewhere.filter((pid) => pid !== foreignPid),
  };
}

export function readPidRecord(file: string): PidRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<PidRecord>;
    if (!parsed || typeof parsed.host !== "string" || typeof parsed.port !== "number") return undefined;
    return {
      host: parsed.host,
      port: parsed.port,
      ...(typeof parsed.listenerPid === "number" ? { listenerPid: parsed.listenerPid } : {}),
      ...(typeof parsed.spawnPid === "number" ? { spawnPid: parsed.spawnPid } : {}),
      ...(parsed.detached === true ? { detached: true } : {}),
    };
  } catch {
    return undefined;
  }
}

export function writePidRecord(file: string, record: PidRecord): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(record), "utf8");
}

export function clearPidRecord(file: string): void {
  rmSync(file, { force: true });
}

export interface EnsureDeps {
  probe: (url: string, password: string | undefined) => Promise<ProbeResult>;
  listeningPid: (host: string, port: number) => Promise<number | undefined>;
  portBusy: (host: string, port: number) => Promise<boolean>;
  killPid: (pid: number) => Promise<void>;
  readPidFile: () => PidRecord | undefined;
  writePidFile: (record: PidRecord) => void;
  clearPidFile: () => void;
  supervise: (options: SuperviseOptions) => Promise<SupervisedProcess>;
  sleep: (ms: number) => Promise<void>;
  alive: (pid: number | undefined) => boolean;
}

export interface EnsureRequest {
  mode: OpenCodeMode;
  onForeign?: ForeignPolicy;
  host: string;
  port: number;
  command: string;
  password?: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  verbose: boolean;
  pidFile: string;
  /** Used as the base URL when attaching to a server the caller already addressed. */
  attachUrl?: string;
  log: (line: string) => void;
  deps?: Partial<EnsureDeps>;
}

export interface EnsuredOpenCode {
  baseUrl: string;
  password: () => string | undefined;
  owned: boolean;
  stop: () => Promise<void>;
}

function defaultDeps(pidFile: string): EnsureDeps {
  return {
    probe: async () => "down",
    listeningPid,
    portBusy: async (host, port) => !(await portAvailable(host, port)),
    killPid: killProcessTree,
    readPidFile: () => readPidRecord(pidFile),
    writePidFile: (record) => writePidRecord(pidFile, record),
    clearPidFile: () => clearPidRecord(pidFile),
    supervise,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    alive: isPidAlive,
  };
}

async function waitUntilFree(deps: EnsureDeps, host: string, port: number): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt++) {
    if (!(await deps.portBusy(host, port))) return;
    await deps.sleep(100);
  }
  throw new Error(`Port ${port} stayed busy after the previous OpenCode process was stopped.`);
}

async function pickPort(deps: EnsureDeps, host: string, start: number): Promise<number> {
  for (let port = start + 1; port <= Math.min(65535, start + 20); port++) {
    if (!(await deps.portBusy(host, port))) return port;
  }
  throw new Error(`No free TCP port near ${start}.`);
}

export async function ensureOpenCode(req: EnsureRequest): Promise<EnsuredOpenCode> {
  const deps: EnsureDeps = { ...defaultDeps(req.pidFile), ...req.deps };
  const preferred = origin(req.host, req.port);
  const record = deps.readPidFile();
  const listenerPid = await deps.listeningPid(req.host, req.port);
  const probe = await deps.probe(req.attachUrl ?? preferred, req.password);
  let recordProbe: ProbeResult | undefined;
  if (record && (record.host !== req.host || record.port !== req.port)) {
    recordProbe = await deps.probe(origin(record.host, record.port), req.password);
  }
  const recordPid = record?.listenerPid ?? record?.spawnPid;
  const action = assessOpenCode({
    mode: req.mode,
    ...(req.onForeign ? { onForeign: req.onForeign } : {}),
    host: req.host,
    port: req.port,
    ...(listenerPid ? { listenerPid } : {}),
    probe,
    ...(record ? { record } : {}),
    recordAlive: deps.alive(recordPid),
    ...(recordProbe ? { recordProbe } : {}),
  });
  if (action.type === "fail") throw new Error(action.message);
  if (action.type === "wait") {
    req.log(action.message);
    const baseUrl = req.attachUrl ?? origin(action.host, action.port);
    return {
      baseUrl,
      password: () => req.password,
      owned: false,
      stop: async () => {},
    };
  }
  req.log(action.message);

  const spawnAt = async (host: string, port: number): Promise<SupervisedProcess> =>
    deps.supervise({
      command: req.command,
      args: buildServeArgs(host, port),
      env: req.env,
      shell: process.platform === "win32",
      ...(req.password ? { password: req.password } : {}),
      signal: req.signal,
      log: (line) => req.log(line),
      ...(req.verbose ? { output: (line: string) => req.log(line) } : {}),
      probe: (password) => deps.probe(origin(host, port), password),
      onReady: async ({ spawnPid }) => {
        const heard = await deps.listeningPid(host, port);
        deps.writePidFile({
          host,
          port,
          ...(heard ? { listenerPid: heard } : {}),
          ...(spawnPid ? { spawnPid } : {}),
        });
      },
    });

  if (action.type === "attach") {
    const baseUrl = req.attachUrl && action.host === req.host && action.port === req.port ? req.attachUrl : origin(action.host, action.port);
    if (!action.owned) {
      if (!record?.detached) deps.clearPidFile();
      return {
        baseUrl,
        password: () => req.password,
        owned: false,
        stop: async () => {},
      };
    }
    let replaced: SupervisedProcess | undefined;
    let stopped = false;
    const watched = action.pid;
    if (watched) {
      const loop = (async () => {
        while (!req.signal.aborted && !stopped && !replaced) {
          if (!deps.alive(watched)) {
            if (stopped || req.signal.aborted) return;
            req.log(`OpenCode pid ${watched} exited. Starting it again.`);
            replaced = await spawnAt(action.host, action.port);
            if (stopped || req.signal.aborted) {
              await replaced.stop();
              deps.clearPidFile();
            }
            return;
          }
          await deps.sleep(1000);
        }
      })();
      void loop.catch((err) => {
        req.log(err instanceof Error ? err.message : String(err));
      });
    }
    return {
      baseUrl,
      password: () => replaced?.password() ?? req.password,
      owned: true,
      stop: async () => {
        stopped = true;
        if (replaced) await replaced.stop();
        else if (watched && deps.alive(watched)) await deps.killPid(watched);
        deps.clearPidFile();
      },
    };
  }

  for (const pid of action.stopPids) await deps.killPid(pid);
  let host = req.host;
  let port = req.port;
  if (action.type === "replace") {
    await deps.killPid(action.pid);
    await waitUntilFree(deps, action.host, action.port);
    host = action.host;
    port = action.port;
  } else if (action.type === "spawn-next") {
    port = await pickPort(deps, req.host, req.port);
    req.log(`Starting opencode serve on ${origin(req.host, port)}.`);
  } else {
    host = action.host;
    port = action.port;
  }
  const supervised = await spawnAt(host, port);
  return {
    baseUrl: origin(host, port),
    password: () => supervised.password() ?? req.password,
    owned: true,
    stop: async () => {
      await supervised.stop();
      deps.clearPidFile();
    },
  };
}

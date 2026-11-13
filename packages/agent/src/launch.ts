import { spawn, type SpawnOptions } from "node:child_process";

import { ToolError, type OpenCodeStatus } from "grokcode-shared";

import type { PidRecord } from "./ownership.js";
import { buildServeArgs, type ProbeResult } from "./supervisor.js";

interface DetachedChild {
  pid?: number;
  unref?: () => void;
  stdout?: { on(event: "data", listener: (chunk: Buffer) => void): void } | null;
  once(event: "error", listener: (err: Error) => void): void;
  once(event: "exit", listener: (code: number | null) => void): void;
}

export type SpawnLike = (command: string, args: readonly string[], options: SpawnOptions) => DetachedChild;

export function psLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** PowerShell that starts a process and returns. It must not include -Wait. */
export function windowsStartScript(command: string, args: readonly string[], cwd?: string): string {
  const list = args.map(psLiteral).join(", ");
  const wd = cwd ? ` -WorkingDirectory ${psLiteral(cwd)}` : "";
  return `$p = Start-Process -FilePath ${psLiteral(command)} -ArgumentList @(${list})${wd} -WindowStyle Hidden -PassThru; Write-Output $p.Id`;
}

export interface DetachRequest {
  command: string;
  args: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
  spawnImpl?: SpawnLike;
}

/**
 * Start a process outside the agent's lifetime.
 * Unix uses a detached, unref'd child. Windows uses Start-Process without -Wait
 * so the server is not a node child and Start-Process -Wait on the agent does not hang.
 */
export async function launchDetached(request: DetachRequest): Promise<{ pid?: number }> {
  const spawnImpl = request.spawnImpl ?? (spawn as SpawnLike);
  if (process.platform === "win32" && !request.spawnImpl) {
    return launchWindows(request, spawnImpl);
  }
  const child = spawnImpl(request.command, request.args, {
    cwd: request.cwd,
    env: request.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref?.();
  return { pid: child.pid };
}

async function launchWindows(request: DetachRequest, spawnImpl: SpawnLike): Promise<{ pid?: number }> {
  const script = windowsStartScript(request.command, request.args, request.cwd);
  const child = spawnImpl("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: request.env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  let out = "";
  child.stdout?.on("data", (chunk) => {
    out += chunk.toString("utf8");
  });
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (status) => resolve(status ?? 1));
  });
  if (code !== 0) throw new Error(`Start-Process failed to launch ${request.command} (exit ${code}).`);
  const pid = Number(out.trim().split(/\s+/).pop());
  return { pid: Number.isInteger(pid) && pid > 0 ? pid : undefined };
}

export interface RequestOpenCodeDeps {
  host: string;
  port: number;
  signal?: AbortSignal;
  probe: () => Promise<ProbeResult>;
  launch: () => Promise<{ pid?: number }> | { pid?: number };
  identify: () => Promise<{ version?: string; api?: "v1" | "v2" } | undefined>;
  listeningPid: () => Promise<number | undefined>;
  writePid: (record: PidRecord) => void;
  sleep: (ms: number) => Promise<void>;
  readyTimeoutMs?: number;
}

function origin(host: string, port: number): string {
  return `http://${host}:${port}`;
}

/**
 * Start opencode serve only when nothing is already reachable.
 * The launched process is not killed when `signal` aborts or this function returns.
 */
export async function requestOpenCode(deps: RequestOpenCodeDeps): Promise<OpenCodeStatus & { started: boolean }> {
  const url = origin(deps.host, deps.port);
  const current = await deps.probe();
  if (current === "unauthorized") {
    throw new ToolError(
      `OpenCode at ${url} rejected OPENCODE_PASSWORD. Not starting another server.`,
      "opencode_unauthorized",
    );
  }
  if (current === "up") {
    const described = await describe(deps, url);
    return { ...described, started: false };
  }
  const launched = await deps.launch();
  const deadline = Date.now() + (deps.readyTimeoutMs ?? 30_000);
  while (Date.now() < deadline) {
    if (deps.signal?.aborted) {
      return {
        reachable: false,
        url,
        ...(launched.pid ? { pid: launched.pid } : {}),
        started: true,
      };
    }
    const state = await deps.probe();
    if (state === "up") {
      const heard = await deps.listeningPid();
      deps.writePid({
        host: deps.host,
        port: deps.port,
        detached: true,
        ...(heard ? { listenerPid: heard } : {}),
        ...(launched.pid ? { spawnPid: launched.pid } : {}),
      });
      const described = await describe(deps, url);
      return {
        ...described,
        reachable: true,
        started: true,
        pid: described.pid ?? heard ?? launched.pid,
      };
    }
    await deps.sleep(200);
  }
  throw new ToolError(
    `Started opencode serve on ${url} but it did not become reachable. The process was left running.`,
    "opencode_unavailable",
  );
}

async function describe(deps: RequestOpenCodeDeps, url: string): Promise<OpenCodeStatus> {
  const heard = await deps.listeningPid();
  const info = await deps.identify();
  return {
    reachable: true,
    url,
    ...(info?.version ? { version: info.version } : {}),
    ...(info?.api ? { api: info.api } : {}),
    ...(heard ? { pid: heard } : {}),
  };
}

export function serveLaunch(host: string, port: number, command: string, env: NodeJS.ProcessEnv, cwd?: string): DetachRequest {
  return {
    command,
    args: buildServeArgs(host, port),
    env,
    ...(cwd ? { cwd } : {}),
  };
}

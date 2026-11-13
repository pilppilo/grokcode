import { spawn, type SpawnOptions } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { ToolError, type OpenCodeStatus } from "grokcode-shared";

import type { PidRecord } from "./ownership.js";
import { buildServeArgs, type ProbeResult } from "./supervisor.js";

interface DetachedChild {
  pid?: number;
  unref?: () => void;
  kill?: (signal?: NodeJS.Signals | number) => boolean;
  stdout?: { on(event: "data", listener: (chunk: Buffer) => void): void } | null;
  stderr?: { on(event: "data", listener: (chunk: Buffer) => void): void } | null;
  once(event: "error", listener: (err: Error) => void): void;
  once(event: "exit", listener: (code: number | null) => void): void;
}

/** Stay under the relay's 20s call budget, including the Windows launcher. */
export const START_OPENCODE_READY_MS = 12_000;
export const WINDOWS_LAUNCH_TIMEOUT_MS = 8_000;

const WINDOWS_EXE_EXTS = [".exe", ".cmd", ".bat"] as const;

export type SpawnLike = (command: string, args: readonly string[], options: SpawnOptions) => DetachedChild;

export function psLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** PowerShell that starts a process and returns. It must not include -Wait. */
export function windowsStartScript(command: string, args: readonly string[], cwd?: string): string {
  const list = args.map(psLiteral).join(", ");
  const wd = cwd ? ` -WorkingDirectory ${psLiteral(cwd)}` : "";
  return [
    "$ErrorActionPreference = 'Stop'",
    "try {",
    `  $p = Start-Process -FilePath ${psLiteral(command)} -ArgumentList @(${list})${wd} -WindowStyle Hidden -PassThru`,
    "  if (-not $p) { throw 'Start-Process returned no process.' }",
    "  Write-Output $p.Id",
    "} catch {",
    "  [Console]::Error.WriteLine($_.Exception.Message)",
    "  exit 1",
    "}",
  ].join("\n");
}

export interface WindowsResolveOptions {
  path: string;
  exists: (file: string) => boolean;
  readText?: (file: string) => string;
  comSpec?: string;
}

export interface ResolvedWindowsCommand {
  file: string;
  argsPrefix: string[];
}

/**
 * Turn `opencode` into a real Windows program. PATH is searched for .exe, then
 * .cmd/.bat. .ps1 and extensionless npm shims are never executed. An npm .cmd
 * is replaced by node_modules/@opencode/cli/bin/opencode.exe when that file exists.
 */
export function resolveWindowsExecutable(command: string, options: WindowsResolveOptions): ResolvedWindowsCommand {
  const tried: string[] = [];
  const trimmed = command.trim();
  if (!trimmed) {
    throw new ToolError("OpenCode executable name is empty.", "opencode_bin");
  }
  const ext = path.win32.extname(trimmed).toLowerCase();
  const hasDir = path.win32.isAbsolute(trimmed) || trimmed.includes("\\") || trimmed.includes("/");
  if (hasDir) {
    const resolved = resolveExplicitWindows(trimmed, ext, options, tried);
    if (resolved) return resolved;
  } else {
    const base = ext ? path.win32.basename(trimmed, ext) : trimmed;
    const exts: Array<(typeof WINDOWS_EXE_EXTS)[number]> =
      ext === ".exe" || ext === ".cmd" || ext === ".bat" ? [ext] : [...WINDOWS_EXE_EXTS];
    for (const candidateExt of exts) {
      for (const dir of splitPath(options.path)) {
        const candidate = path.win32.join(dir, base + candidateExt);
        const resolved = acceptCandidate(candidate, candidateExt, options, tried);
        if (resolved) return resolved;
      }
    }
  }
  throw new ToolError(
    `Could not resolve "${trimmed}" to a Windows executable (.exe, .cmd, or .bat). .ps1 and extensionless shims are not used. Tried: ${tried.join("; ") || "(PATH is empty)"}.`,
    "opencode_bin",
  );
}

function resolveExplicitWindows(
  command: string,
  ext: string,
  options: WindowsResolveOptions,
  tried: string[],
): ResolvedWindowsCommand | undefined {
  if (ext === ".exe" || ext === ".cmd" || ext === ".bat") {
    return acceptCandidate(command, ext, options, tried);
  }
  const dir = path.win32.dirname(command);
  const base = path.win32.basename(command, ext);
  for (const candidateExt of WINDOWS_EXE_EXTS) {
    const candidate = path.win32.join(dir, base + candidateExt);
    const resolved = acceptCandidate(candidate, candidateExt, options, tried);
    if (resolved) return resolved;
  }
  tried.push(`${command} (refused ${ext || "extensionless"} shim)`);
  return undefined;
}

function acceptCandidate(
  candidate: string,
  ext: ".exe" | ".cmd" | ".bat",
  options: WindowsResolveOptions,
  tried: string[],
): ResolvedWindowsCommand | undefined {
  tried.push(candidate);
  if (!options.exists(candidate)) return undefined;
  if (ext === ".exe") return { file: candidate, argsPrefix: [] };
  const unpacked = npmOpencodeExe(candidate, options);
  if (unpacked) {
    tried.push(unpacked);
    return { file: unpacked, argsPrefix: [] };
  }
  const comSpec = options.comSpec || "cmd.exe";
  return { file: comSpec, argsPrefix: ["/d", "/c", candidate] };
}

function npmOpencodeExe(shimPath: string, options: WindowsResolveOptions): string | undefined {
  const dir = path.win32.dirname(shimPath);
  const known = path.win32.join(dir, "node_modules", "@opencode", "cli", "bin", "opencode.exe");
  if (options.exists(known)) return known;
  if (!options.readText) return undefined;
  let text = "";
  try {
    text = options.readText(shimPath);
  } catch {
    return undefined;
  }
  const hints = new Set<string>();
  for (const match of text.matchAll(/["']([^"']*opencode\.exe)["']/gi)) {
    let raw = match[1] ?? "";
    raw = raw.replace(/%~?dp0%\\?/gi, "");
    if (!raw) continue;
    hints.add(path.win32.isAbsolute(raw) ? raw : path.win32.normalize(path.win32.join(dir, raw)));
  }
  for (const hint of hints) {
    if (options.exists(hint)) return hint;
  }
  return undefined;
}

function splitPath(value: string): string[] {
  return value.split(";").map((part) => part.trim()).filter(Boolean);
}

export interface DetachRequest {
  command: string;
  args: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
  spawnImpl?: SpawnLike;
  /** Test override. Production uses the current platform. */
  platform?: NodeJS.Platform;
  exists?: (file: string) => boolean;
  readText?: (file: string) => string;
  launchTimeoutMs?: number;
}

/**
 * Start a process outside the agent's lifetime.
 * Unix uses a detached, unref'd child. Windows uses Start-Process without -Wait
 * so the server is not a node child and Start-Process -Wait on the agent does not hang.
 */
export async function launchDetached(request: DetachRequest): Promise<{ pid?: number }> {
  const spawnImpl = request.spawnImpl ?? (spawn as SpawnLike);
  const platform = request.platform ?? process.platform;
  if (platform === "win32") {
    const resolved = resolveWindowsExecutable(request.command, {
      path: request.env.PATH ?? request.env.Path ?? "",
      exists: request.exists ?? existsSync,
      readText: request.readText ?? ((file) => readFileSync(file, "utf8")),
      comSpec: request.env.ComSpec || request.env.COMSPEC,
    });
    return launchWindows(
      { ...request, command: resolved.file, args: [...resolved.argsPrefix, ...request.args] },
      spawnImpl,
    );
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
  const timeoutMs = request.launchTimeoutMs ?? WINDOWS_LAUNCH_TIMEOUT_MS;
  const child = spawnImpl("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: request.env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout?.on("data", (chunk) => {
    out += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk) => {
    err += chunk.toString("utf8");
  });
  const code = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        child.kill?.();
      } catch {
        /* already gone */
      }
      reject(
        new ToolError(
          `Start-Process timed out after ${timeoutMs}ms launching ${request.command}.${err.trim() ? ` ${err.trim()}` : ""}`,
          "opencode_bin",
        ),
      );
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (status) => {
      clearTimeout(timer);
      resolve(status ?? 1);
    });
  });
  if (code !== 0) {
    const detail = err.trim() || out.trim() || `exit ${code}`;
    throw new ToolError(`Start-Process failed to launch ${request.command}: ${detail}`, "opencode_bin");
  }
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
  const deadline = Date.now() + (deps.readyTimeoutMs ?? START_OPENCODE_READY_MS);
  while (Date.now() < deadline) {
    if (deps.signal?.aborted) break;
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
  if (launched.pid) {
    deps.writePid({
      host: deps.host,
      port: deps.port,
      detached: true,
      spawnPid: launched.pid,
    });
  }
  return {
    reachable: false,
    url,
    ...(launched.pid ? { pid: launched.pid } : {}),
    started: true,
  };
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

/** `opencode service start` — the managed background service the OpenCode app attaches to. */
export function serviceStartLaunch(command: string, env: NodeJS.ProcessEnv, cwd?: string): DetachRequest {
  return {
    command,
    args: ["service", "start"],
    env,
    ...(cwd ? { cwd } : {}),
  };
}

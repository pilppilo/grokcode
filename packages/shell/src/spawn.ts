import { spawn, type ChildProcess } from "node:child_process";
import fs, { existsSync } from "node:fs";
import pathPosix from "node:path/posix";
import pathWin32 from "node:path/win32";
import { Readable } from "node:stream";

import { ToolError, type PathPlatform } from "grokcode-shared";

import { isBareCommandName, withinRoots } from "./confine.js";

export interface SpawnSpec {
  argv: string[];
  cwd: string;
  platform: PathPlatform;
  shell: boolean;
  /** Shell command text. Required when shell is true. */
  command?: string;
  env?: NodeJS.ProcessEnv;
  /** Policy roots. A resolved binary inside one of these is refused. */
  roots?: readonly string[];
}

export interface Spawned {
  stdout: Readable | null;
  stderr: Readable | null;
  kill(signal?: NodeJS.Signals): void | Promise<void>;
  onExit(cb: (code: number | null, signal: NodeJS.Signals | null, error?: Error) => void): void;
}

export type SpawnFn = (spec: SpawnSpec) => Spawned;

/**
 * Names copied into a child. Everything else is dropped, including GIT_*,
 * LD_PRELOAD, LD_LIBRARY_PATH, DYLD_*, NODE_OPTIONS, RIPGREP_CONFIG_PATH,
 * BASH_ENV, and PYTHONPATH. Safe git variables are set again below.
 */
const ENV_ALLOW = [
  "PATH",
  "Path",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "SystemRoot",
  "WINDIR",
  "SYSTEMDRIVE",
  "ComSpec",
  "COMSPEC",
  "TEMP",
  "TMP",
  "TMPDIR",
  "LANG",
  "LC_CTYPE",
  "USER",
  "USERNAME",
  "LOGNAME",
  "PATHEXT",
  "TERM",
  "TZ",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "COMMONPROGRAMFILES",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "OS",
  "GROKCODE_PWSH",
] as const;

export function sanitizePath(value: string, platform: PathPlatform): string {
  const path = platform === "win32" ? pathWin32 : pathPosix;
  const sep = platform === "win32" ? ";" : ":";
  return value
    .split(sep)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "" && entry !== "." && entry !== ".." && path.isAbsolute(entry))
    .join(sep);
}

/** The operator PATH with `.` and relative entries removed. Command lookup uses this, not the child environment. */
export function trustedPath(platform: PathPlatform): string {
  return sanitizePath(process.env.PATH || process.env.Path || "", platform);
}

export function childEnv(base: NodeJS.ProcessEnv, platform: PathPlatform): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_ALLOW) {
    const value = base[key];
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }
  const cleaned = sanitizePath(base.PATH || base.Path || "", platform);
  if (cleaned) {
    env.PATH = cleaned;
    if (platform === "win32") env.Path = cleaned;
  }
  env.PYTHONIOENCODING = "utf-8";
  env.PYTHONUTF8 = "1";
  env.LANG = "C.UTF-8";
  env.LC_ALL = "C.UTF-8";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GCM_INTERACTIVE = "Never";
  env.HUSKY = "0";
  if (platform === "win32") env.LESSCHARSET = "utf-8";
  return env;
}

/**
 * Quote one argument for a future Windows script shim.
 * Every argument is quoted. `;`, `,`, and `=` are rejected because cmd.exe
 * can treat them as separators even inside the `/c` string. `%`, quotes, and
 * control characters are rejected too.
 *
 * `.cmd` / `.bat` shims are denied today (git and rg are `.exe`). If
 * `SCRIPT_SHIM_ALLOWLIST` later gains npm, pnpm, or npx, this reject list
 * stays in force.
 */
export function quoteCmdArg(arg: string): string {
  if (/["%;,=\x00-\x1f]/.test(arg)) {
    throw new Error(
      "Windows batch arguments cannot contain quotes, percent signs, semicolons, commas, equals signs, or control characters.",
    );
  }
  return `"${arg}"`;
}

/**
 * Empty on purpose. Add "npm", "pnpm", or "npx" here to resolve those Windows
 * shims, and keep quoteCmdArg's rejects for `;`, `,`, and `=`.
 */
export const SCRIPT_SHIM_ALLOWLIST: ReadonlySet<string> = new Set<string>();

export interface ResolveCommandOptions {
  platform: PathPlatform;
  pathEnv: string;
  roots: readonly string[];
  exists?: (file: string) => boolean;
  realpath?: (file: string) => string;
}

/** Resolve a bare command from a fixed PATH. Refuse script shims and anything that lands inside a policy root. */
export function resolveTrustedCommand(name: string, options: ResolveCommandOptions): string {
  if (!isBareCommandName(name)) throw new ToolError("command must be a bare name with no path.", "policy_denied");
  if (/\.(?:cmd|bat|com)$/i.test(name)) {
    throw new ToolError("Windows script shims (.cmd, .bat, .com) are denied.", "policy_denied");
  }
  const path = options.platform === "win32" ? pathWin32 : pathPosix;
  const exists = options.exists ?? existsSync;
  const realpath =
    options.realpath ??
    ((file: string) => {
      try {
        return fs.realpathSync.native(file);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") throw err;
        return fs.realpathSync(file);
      }
    });
  const base = options.platform === "win32" ? name.toLowerCase().replace(/\.exe$/i, "") : name;
  const names =
    options.platform === "win32"
      ? pathWin32.extname(name).toLowerCase() === ".exe"
        ? [name]
        : [`${base}.exe`]
      : [name];
  if (SCRIPT_SHIM_ALLOWLIST.has(base)) names.push(`${base}.cmd`, `${base}.bat`);
  const sep = options.platform === "win32" ? ";" : ":";
  for (const dir of sanitizePath(options.pathEnv, options.platform).split(sep)) {
    if (!dir) continue;
    if (withinRoots(dir, options.roots, options.platform)) continue;
    for (const candidate of names) {
      const full = path.join(dir, candidate);
      if (!exists(full)) continue;
      let real: string;
      try {
        real = realpath(full);
      } catch {
        continue;
      }
      if (withinRoots(real, options.roots, options.platform)) {
        throw new ToolError("command resolves inside a policy root.", "policy_denied");
      }
      if (/\.(?:cmd|bat|com)$/i.test(real) && !SCRIPT_SHIM_ALLOWLIST.has(base)) {
        throw new ToolError("Windows script shims (.cmd, .bat, .com) are denied.", "policy_denied");
      }
      return real;
    }
  }
  throw new ToolError(`command was not found on PATH: ${name}`, "not_found");
}

const detachedChildren = new Set<ChildProcess>();

function trackChild(child: ChildProcess): void {
  detachedChildren.add(child);
  const drop = () => detachedChildren.delete(child);
  child.once("exit", drop);
  child.once("error", drop);
}

/** Kill process groups left behind by detached spawns. Called on shutdown. */
export function reapDetachedChildren(): void {
  for (const child of detachedChildren) {
    const pid = child.pid;
    if (!pid) continue;
    try {
      if (process.platform !== "win32") process.kill(-pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
  detachedChildren.clear();
}

/**
 * Resolve a Windows command to `name.exe` only.
 * `.cmd`, `.bat`, and `.com` are not selected. See `SCRIPT_SHIM_ALLOWLIST`.
 */
export function resolveExecutable(file: string, platform: PathPlatform, env: NodeJS.ProcessEnv): string {
  if (!isBareCommandName(file)) return file;
  if (/\.(?:cmd|bat|com)$/i.test(file)) return file;
  try {
    return resolveTrustedCommand(file, {
      platform,
      pathEnv: env.PATH || env.Path || trustedPath(platform),
      roots: [],
    });
  } catch {
    return file;
  }
}

function wrap(child: ChildProcess, platform: PathPlatform, env: NodeJS.ProcessEnv): Spawned {
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  type ExitArgs = Parameters<Parameters<Spawned["onExit"]>[0]>;
  let result: ExitArgs | undefined;
  const listeners: Array<(...args: ExitArgs) => void> = [];
  const finish = (...args: ExitArgs) => {
    if (result) return;
    result = args;
    for (const listener of listeners.splice(0)) listener(...args);
  };
  child.on("error", (error) => finish(null, null, error));
  child.once("close", (code, signal) => finish(code, signal));
  let killing = false;
  return {
    stdout: child.stdout,
    stderr: child.stderr,
    kill() {
      const pid = child.pid;
      if (!pid || killing) return;
      killing = true;
      if (platform === "win32") {
        const root = env.SystemRoot ?? process.env.SystemRoot ?? "C:\\Windows";
        const killer = spawn(pathWin32.join(root, "System32", "taskkill.exe"), ["/pid", String(pid), "/t", "/f"], {
          windowsHide: true,
          stdio: "ignore",
        });
        killer.on("error", () => child.kill("SIGKILL"));
        killer.on("exit", (code) => { if (code !== 0) child.kill("SIGKILL"); });
        return;
      }
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    },
    onExit(cb) {
      if (result) cb(...result);
      else listeners.push(cb);
    },
  };
}

export function defaultSpawn(spec: SpawnSpec): Spawned {
  const env = spec.env ?? childEnv(process.env, spec.platform);
  const options = {
    cwd: spec.cwd,
    env,
    shell: false,
    windowsHide: true,
    detached: spec.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
  };
  const launch = (child: ChildProcess) => {
    trackChild(child);
    return wrap(child, spec.platform, env);
  };
  if (spec.shell) {
    const command = spec.command ?? "";
    if (spec.platform === "win32") {
      const pwsh = env.GROKCODE_PWSH || "pwsh";
      const script = [
        "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
        "$OutputEncoding = [Console]::OutputEncoding",
        command,
      ].join("\n");
      return launch(spawn(pwsh, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], options));
    }
    return launch(spawn("bash", ["--noprofile", "--norc", "-c", command], options));
  }
  let [file, ...args] = spec.argv;
  if (!file) throw new Error("argv is empty");
  if (/\.(?:cmd|bat|com)$/i.test(file)) {
    const base = (spec.platform === "win32" ? pathWin32 : pathPosix).basename(file, (spec.platform === "win32" ? pathWin32 : pathPosix).extname(file)).toLowerCase();
    if (!SCRIPT_SHIM_ALLOWLIST.has(base)) {
      throw new Error("Windows script shims (.cmd, .bat, .com) are denied.");
    }
    // Future npm/pnpm/npx shims: quoteCmdArg rejects `;`, `,`, and `=`.
    const comspec = env.ComSpec || "cmd.exe";
    const line = [file, ...args].map(quoteCmdArg).join(" ");
    return launch(spawn(comspec, ["/d", "/v:off", "/s", "/c", `"${line}"`], { ...options, windowsVerbatimArguments: true }));
  }
  const path = spec.platform === "win32" ? pathWin32 : pathPosix;
  if (!path.isAbsolute(file)) {
    file = resolveTrustedCommand(file, {
      platform: spec.platform,
      pathEnv: trustedPath(spec.platform),
      roots: spec.roots ?? [],
    });
  } else if (spec.roots && withinRoots(file, spec.roots, spec.platform)) {
    throw new Error("command resolves inside a policy root.");
  }
  return launch(spawn(file, args, options));
}

export async function runAndWait(
  spec: SpawnSpec,
  timeoutMs: number,
  maxOutput: number,
  spawnImpl: SpawnFn = defaultSpawn,
): Promise<{ code: number | null; output: string; stdout: string; stderr: string; truncated: boolean; timedOut: boolean }> {
  const spawned = spawnImpl(spec);
  let stdout = "";
  let stderr = "";
  let truncated = false;
  const push = (target: "stdout" | "stderr", chunk: string) => {
    if (truncated) return;
    if (target === "stdout") stdout += chunk;
    else stderr += chunk;
    if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > maxOutput) {
      truncated = true;
      spawned.kill("SIGTERM");
    }
  };
  spawned.stdout?.on("data", (chunk: string) => push("stdout", String(chunk)));
  spawned.stderr?.on("data", (chunk: string) => push("stderr", String(chunk)));
  const result = await new Promise<{ code: number | null; timedOut: boolean }>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number | null, timedOut: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, timedOut });
    };
    let timingOut = false;
    timer = setTimeout(() => {
      timingOut = true;
      const grace = setTimeout(() => finish(null, true), 500);
      spawned.onExit(() => {
        clearTimeout(grace);
        finish(null, true);
      });
      void Promise.resolve(spawned.kill("SIGTERM")).catch(() => {
        clearTimeout(grace);
        finish(null, true);
      });
    }, timeoutMs);
    spawned.onExit((code, _signal, error) => {
      if (error) stderr += error.message;
      if (timingOut) return;
      finish(code, false);
    });
  });
  return { code: result.code, output: stdout + stderr, stdout, stderr, truncated, timedOut: result.timedOut };
}

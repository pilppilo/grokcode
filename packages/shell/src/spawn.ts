import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { Readable } from "node:stream";
import pathWin32 from "node:path/win32";

import type { PathPlatform } from "grokcode-shared";

export interface SpawnSpec {
  argv: string[];
  cwd: string;
  platform: PathPlatform;
  shell: boolean;
  /** Shell command text. Required when shell is true. */
  command?: string;
  env?: NodeJS.ProcessEnv;
}

export interface Spawned {
  stdout: Readable | null;
  stderr: Readable | null;
  kill(signal?: NodeJS.Signals): void;
  onExit(cb: (code: number | null, signal: NodeJS.Signals | null, error?: Error) => void): void;
}

export type SpawnFn = (spec: SpawnSpec) => Spawned;

export function childEnv(base: NodeJS.ProcessEnv, platform: PathPlatform): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  delete env.BASH_ENV;
  delete env.ENV;
  delete env.SHELLOPTS;
  delete env.PS4;
  env.PYTHONIOENCODING = "utf-8";
  env.PYTHONUTF8 = "1";
  env.LANG = "C.UTF-8";
  env.LC_ALL = "C.UTF-8";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GCM_INTERACTIVE = "Never";
  if (platform === "win32") env.LESSCHARSET = "utf-8";
  return env;
}

/** Quote an argument from the conservative subset supported by Windows batch shims. */
export function quoteCmdArg(arg: string): string {
  if (/["%\x00-\x1f]/.test(arg)) {
    throw new Error("Windows batch arguments cannot contain quotes, percent signs, or control characters.");
  }
  if (!arg || /[\s&|<>^!()]/.test(arg)) return `"${arg}"`;
  return arg;
}

/**
 * On Windows, `CreateProcess` will not run a `.cmd` or `.bat` directly.
 * Resolve `git` to `git.exe` or `git.cmd` and wrap the cmd shims. `.ps1` is never selected.
 */
export function resolveExecutable(file: string, platform: PathPlatform, env: NodeJS.ProcessEnv): string {
  if (platform !== "win32") return file;
  if (/[\\/]/.test(file) || pathWin32.extname(file)) return file;
  const pathEnv = env.PATH || env.Path || "";
  for (const dir of pathEnv.split(";")) {
    if (!dir) continue;
    for (const ext of [".exe", ".cmd", ".bat"]) {
      const candidate = pathWin32.join(dir, file + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return file;
}

function wrap(child: ChildProcess, platform: PathPlatform, env: NodeJS.ProcessEnv): Spawned {
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  let spawnError: Error | undefined;
  child.on("error", (error) => { spawnError ??= error; });
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
      child.once("close", (code, signal) => cb(code, signal, spawnError));
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
  if (spec.shell) {
    const command = spec.command ?? "";
    if (spec.platform === "win32") {
      const pwsh = env.GROKCODE_PWSH || "pwsh";
      const script = [
        "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
        "$OutputEncoding = [Console]::OutputEncoding",
        command,
      ].join("\n");
      return wrap(spawn(pwsh, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], options), spec.platform, env);
    }
    return wrap(spawn("bash", ["--noprofile", "--norc", "-c", command], options), spec.platform, env);
  }
  const [file, ...args] = spec.argv;
  if (!file) throw new Error("argv is empty");
  const resolved = resolveExecutable(file, spec.platform, env);
  if (spec.platform === "win32" && /\.(cmd|bat)$/i.test(resolved)) {
    const comspec = env.ComSpec || "cmd.exe";
    const line = [resolved, ...args].map(quoteCmdArg).join(" ");
    return wrap(
      spawn(comspec, ["/d", "/v:off", "/s", "/c", `"${line}"`], {
        ...options,
        windowsVerbatimArguments: true,
      }),
      spec.platform,
      env,
    );
  }
  return wrap(spawn(resolved, args, options), spec.platform, env);
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
    timer = setTimeout(() => {
      spawned.kill("SIGTERM");
      finish(null, true);
    }, timeoutMs);
    spawned.onExit((code, _signal, error) => {
      if (error) stderr += error.message;
      finish(code, false);
    });
  });
  return { code: result.code, output: stdout + stderr, stdout, stderr, truncated, timedOut: result.timedOut };
}

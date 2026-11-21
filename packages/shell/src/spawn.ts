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
  onExit(cb: (code: number | null, signal: NodeJS.Signals | null) => void): void;
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

/** Quote one argument for `cmd.exe /d /v:off /s /c`. Percent signs are escaped so cmd does not expand them. */
export function quoteCmdArg(arg: string): string {
  const escaped = arg.replace(/%/g, "%%");
  if (escaped.length === 0) return '""';
  if (!/[\s"&|<>^!]/.test(escaped)) return escaped;
  return `"${escaped.replace(/"/g, '""')}"`;
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

function wrap(child: ChildProcess): Spawned {
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  return {
    stdout: child.stdout,
    stderr: child.stderr,
    kill(signal = "SIGTERM") {
      try {
        child.kill(signal);
      } catch {
        /* already exited */
      }
    },
    onExit(cb) {
      child.once("error", () => cb(null, null));
      child.once("close", (code, signal) => cb(code, signal));
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
      return wrap(spawn(pwsh, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], options));
    }
    return wrap(spawn("bash", ["--noprofile", "--norc", "-c", command], options));
  }
  const [file, ...args] = spec.argv;
  if (!file) throw new Error("argv is empty");
  const resolved = resolveExecutable(file, spec.platform, env);
  if (spec.platform === "win32" && /\.(cmd|bat)$/i.test(resolved)) {
    const comspec = env.ComSpec || "cmd.exe";
    const line = [resolved, ...args].map(quoteCmdArg).join(" ");
    return wrap(
      spawn(comspec, ["/d", "/v:off", "/s", "/c", line], {
        ...options,
        windowsVerbatimArguments: true,
      }),
    );
  }
  return wrap(spawn(resolved, args, options));
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
    spawned.onExit((code) => finish(code, false));
  });
  return { code: result.code, output: stdout + stderr, stdout, stderr, truncated, timedOut: result.timedOut };
}

import { spawn, type ChildProcess } from "node:child_process";

import { OpenCodeError, detectOpenCode, type FetchLike, type OpenCodeAuth } from "grokcode-shared";

import { killProcessTree } from "./ports.js";
import { redactSecrets, scanServerPassword } from "./password.js";

export function buildServeArgs(hostname: string, port: number): string[] {
  return ["serve", "--hostname", hostname, "--port", String(port)];
}

export type ProbeResult = "up" | "unauthorized" | "down";

export async function probeOpenCode(
  url: string,
  auth: OpenCodeAuth,
  fetchImpl?: FetchLike,
  timeoutMs = 2000,
): Promise<ProbeResult> {
  try {
    await detectOpenCode({ baseUrl: url, auth, ...(fetchImpl ? { fetch: fetchImpl } : {}), timeoutMs });
    return "up";
  } catch (err) {
    if (err instanceof OpenCodeError && (err.status === 401 || err.code === "opencode_unauthorized")) return "unauthorized";
    return "down";
  }
}

export interface SuperviseOptions {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  shell?: boolean;
  /** Called with the password currently known (configured or scraped). */
  probe: (password: string | undefined) => Promise<ProbeResult>;
  password?: string;
  signal?: AbortSignal;
  /** Lifecycle lines (start failures, exits). */
  log?: (line: string) => void;
  /** Child stdout and stderr, already redacted. Omitted output is ignored. */
  output?: (line: string) => void;
  /** Fired each time the child is up, including after a restart. */
  onReady?: (info: { spawnPid: number | undefined }) => void | Promise<void>;
  readyTimeoutMs?: number;
  pollMs?: number;
}

export interface SupervisedProcess {
  password: () => string | undefined;
  pid: () => number | undefined;
  stop: () => Promise<void>;
}

/**
 * Start `opencode serve` and restart it until `signal` aborts.
 * Resolves once the probe reports the server is up.
 */
export async function supervise(options: SuperviseOptions): Promise<SupervisedProcess> {
  const log = options.log ?? (() => {});
  let scraped: string | undefined;
  let child: ChildProcess | undefined;
  let stopping = false;
  const readyTimeoutMs = options.readyTimeoutMs ?? 30_000;
  const pollMs = options.pollMs ?? 250;

  const knownPassword = () => options.password ?? scraped;

  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  let wakeRestart: (() => void) | undefined;
  const stop = async () => {
    stopping = true;
    if (restartTimer) clearTimeout(restartTimer);
    wakeRestart?.();
    const current = child;
    const pid = current?.pid;
    if (!current || pid == null || current.exitCode != null) return;
    await killProcessTree(pid);
  };
  options.signal?.addEventListener("abort", () => {
    void stop();
  }, { once: true });

  let spawnError: Error | undefined;
  const startChild = () => {
    const env = { ...options.env };
    const password = knownPassword();
    if (password) {
      env.OPENCODE_PASSWORD = password;
      env.OPENCODE_SERVER_PASSWORD = password;
    }
    const proc = spawn(options.command, options.args, {
      env,
      shell: options.shell ?? false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = proc;
    proc.on("error", (err) => {
      spawnError = err;
      log(`failed to start ${options.command}: ${err.message}`);
      if ((err as NodeJS.ErrnoException).code === "ENOENT") stopping = true;
    });
    const consume = (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split(/\r?\n/)) {
        if (!line) continue;
        const found = scanServerPassword(line);
        if (found && !options.password) scraped = found;
        options.output?.(redactSecrets(line));
      }
    };
    proc.stdout?.on("data", consume);
    proc.stderr?.on("data", consume);
    proc.on("exit", (code, signal) => {
      if (!stopping) log(`opencode serve exited (${signal ?? code ?? "unknown"}). Restarting.`);
    });
  };

  const publishReady = async () => {
    try {
      await options.onReady?.({ spawnPid: child?.pid });
    } catch (err) {
      log(`could not record the opencode pid: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const deadline = Date.now() + readyTimeoutMs;
  let delay = 200;
  while (!stopping) {
    if (!child || child.exitCode != null || child.signalCode != null) startChild();
    const state = await options.probe(knownPassword());
    if (state === "up") {
      await publishReady();
      const keepAlive = async () => {
        while (!stopping) {
          const dead = !child || child.exitCode != null || child.signalCode != null;
          if (dead) {
            startChild();
            while (!stopping && child && child.exitCode == null && child.signalCode == null) {
              const again = await options.probe(knownPassword());
              if (again === "up") {
                await publishReady();
                break;
              }
              await new Promise((resolve) => setTimeout(resolve, pollMs));
            }
          }
          await new Promise<void>((resolve) => {
            wakeRestart = resolve;
            restartTimer = setTimeout(resolve, 1000);
          });
        }
      };
      void keepAlive();
      return { password: knownPassword, pid: () => child?.pid, stop };
    }
    if (state === "unauthorized" && knownPassword()) {
      await stop();
      throw new Error(
        "OpenCode rejected OPENCODE_PASSWORD. The username is always \"opencode\". Fix the password or stop the other server on this port.",
      );
    }
    if (Date.now() > deadline) {
      await stop();
      throw new Error("Timed out waiting for opencode serve to become ready.");
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(delay, pollMs)));
    delay = Math.min(delay + 100, 1000);
  }
  if (spawnError && (spawnError as NodeJS.ErrnoException).code === "ENOENT") {
    throw new Error(`Could not start ${options.command}: ${spawnError.message}`);
  }
  throw new Error("Supervisor stopped before OpenCode was ready.");
}

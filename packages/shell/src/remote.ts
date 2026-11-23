import {
  DEFAULT_SYNC_WAIT_MS,
  MAX_SYNC_WAIT_MS,
  ToolError,
  errorCode,
  type Clock,
  type MachineBackend,
} from "grokcode-shared";

import { SHELL_INSTRUCTIONS, SHELL_SERVER_NAME, SHELL_SERVER_VERSION, SHELL_TOOLS } from "./tools.js";

export { SHELL_INSTRUCTIONS, SHELL_SERVER_NAME, SHELL_SERVER_VERSION, SHELL_TOOLS };

const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function resolveMachine(backend: MachineBackend, requested: unknown): Promise<string> {
  const machines = await backend.listMachines();
  const online = machines.map((machine) => machine.name);
  if (typeof requested === "string" && requested.trim() !== "") {
    const name = requested.trim();
    if (!online.includes(name)) {
      throw new ToolError(`Machine "${name}" is not connected. Online: ${online.join(", ") || "(none)"}`, "machine_offline");
    }
    return name;
  }
  if (backend.mode === "direct" && machines[0]) return machines[0].name;
  if (machines.length === 1) return machines[0]!.name;
  throw new ToolError(`machine is required. Online: ${online.join(", ") || "(none)"}`, "machine_required");
}

function clampWait(requested: unknown, maxSyncWaitMs: number): number {
  const max = Math.min(Math.max(0, maxSyncWaitMs), MAX_SYNC_WAIT_MS);
  if (typeof requested !== "number" || !Number.isFinite(requested)) return Math.min(DEFAULT_SYNC_WAIT_MS, max);
  return Math.max(0, Math.min(requested, max));
}

/**
 * Dispatch one shell-bridge tool. Long commands are admitted and then polled,
 * matching the OpenCode send_prompt pattern, so a Gemini or Cloudflare timeout
 * does not have to cover the whole process.
 */
export async function callShellTool(
  backend: MachineBackend,
  name: string,
  args: unknown,
  options: { maxSyncWaitMs?: number; clock?: Clock } = {},
): Promise<unknown> {
  const tool = SHELL_TOOLS.find((item) => item.name === name);
  if (!tool) throw new ToolError(`Unknown tool ${name}.`, "unknown_tool");
  const record = isRecord(args) ? { ...args } : {};
  if (name === "list_machines") {
    const machines = await backend.listMachines();
    return {
      machines: await Promise.all(machines.map(async (machine) => {
        try {
          const info = await backend.call(machine.name, "shell_info", {}, 3_000);
          return isRecord(info) ? { ...machine, os: info.os, roots: info.roots, policyLoaded: info.policyLoaded, projects: info.projects } : machine;
        } catch {
          return machine;
        }
      })),
    };
  }
  const machine = await resolveMachine(backend, record.machine);
  delete record.machine;
  if (name === "run_command" || name === "run_tests") {
    const wait = record.wait !== false;
    delete record.wait;
    const budget = clampWait(record.timeoutMs, options.maxSyncWaitMs ?? DEFAULT_SYNC_WAIT_MS);
    const clock = options.clock ?? realClock;
    const deadline = clock.now() + budget;
    const started = await backend.call(machine, name === "run_tests" ? "shell_run_tests" : "shell_run", record, 20_000);
    if (!wait) return started;
    const jobId = isRecord(started) && typeof started.jobId === "string" ? started.jobId : undefined;
    if (!jobId || (isRecord(started) && started.status !== "running")) return started;
    let last: unknown = started;
    while (clock.now() < deadline) {
      const remainingBeforePoll = deadline - clock.now();
      if (remainingBeforePoll <= 0) break;
      try {
        last = await backend.call(machine, "shell_job", { jobId }, Math.min(15_000, remainingBeforePoll));
      } catch (error) {
        if (errorCode(error) !== "timeout") throw error;
        break;
      }
      const status = isRecord(last) ? last.status : undefined;
      if (status && status !== "running") {
        if (name === "run_tests" && isRecord(last)) {
          return { ...last, passed: status === "exited" && last.exitCode === 0 };
        }
        return last;
      }
      const remaining = deadline - clock.now();
      if (remaining <= 0) break;
      await clock.sleep(Math.min(400, remaining));
      if (clock.now() >= deadline) break;
    }
    return {
      ...(isRecord(last) ? last : {}),
      status: "running",
      jobId,
      hint: "The sync budget ended before the command exited. Poll get_job or poll_output.",
    };
  }
  if (name === "poll_output") record.view = "poll";
  if (!tool.op) throw new ToolError(`Tool ${name} has no op.`, "unknown_tool");
  const timeout = name === "git_commit_push" ? 90_000 : 20_000;
  const result = await backend.call(machine, tool.op, record, timeout);
  if (name === "git_commit_push") {
    const failure = commitPushFailure(result);
    // isError stays false for a clean commit. A push that fails after the
    // commit is an error, but the payload still carries the SHA so the
    // caller retries the push instead of creating a second commit.
    if (failure) throw new ToolError(failure.message, "push_failed", undefined, failure.details);
  }
  return result;
}

function commitPushFailure(result: unknown): { message: string; details: Record<string, unknown> } | null {
  if (!isRecord(result) || !isRecord(result.push) || result.push.ok !== false) return null;
  const sha = typeof result.sha === "string" ? result.sha : "";
  const branch = typeof result.branch === "string" ? result.branch : "";
  const error = typeof result.push.error === "string" && result.push.error.trim() !== ""
    ? result.push.error
    : "git push failed.";
  const provided = typeof result.message === "string" ? result.message.trim() : "";
  const message = provided !== "" ? provided : fallbackPushMessage(sha, branch, error);
  return {
    message,
    details: {
      committed: true,
      sha,
      branch,
      pushed: false,
      push: result.push,
      ...(typeof result.output === "string" ? { output: result.output } : {}),
    },
  };
}

function fallbackPushMessage(sha: string, branch: string, error: string): string {
  const detail = error.length > 500 ? `${error.slice(0, 500)}…` : error;
  const created = sha
    ? `Commit ${sha} was created on branch ${branch || "(unknown)"}.`
    : `A commit was created on branch ${branch || "(unknown)"}, but its SHA could not be read.`;
  return `${created} The push failed: ${detail} This commit already exists. Do not create another commit. Retry only the push.`;
}

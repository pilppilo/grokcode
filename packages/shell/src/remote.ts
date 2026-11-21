import {
  DEFAULT_SYNC_WAIT_MS,
  MAX_SYNC_WAIT_MS,
  ToolError,
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
  if (name === "list_machines") return { machines: await backend.listMachines() };
  const machine = await resolveMachine(backend, record.machine);
  delete record.machine;
  if (name === "run_command") {
    const wait = record.wait === true;
    delete record.wait;
    const started = await backend.call(machine, "shell_run", record, 20_000);
    if (!wait) return started;
    const jobId = isRecord(started) && typeof started.jobId === "string" ? started.jobId : undefined;
    if (!jobId) return started;
    const budget = clampWait(record.timeoutMs, options.maxSyncWaitMs ?? DEFAULT_SYNC_WAIT_MS);
    const clock = options.clock ?? realClock;
    const deadline = clock.now() + budget;
    let last: unknown = started;
    while (clock.now() <= deadline) {
      last = await backend.call(machine, "shell_job", { jobId }, 15_000);
      const status = isRecord(last) ? last.status : undefined;
      if (status && status !== "running") return last;
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
  return backend.call(machine, tool.op, record, timeout);
}

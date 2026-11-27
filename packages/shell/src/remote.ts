import {
  ToolError,
  errorCode,
  type MachineBackend,
} from "grokcode-shared";

import { SHELL_INSTRUCTIONS, SHELL_SERVER_NAME, SHELL_SERVER_VERSION, SHELL_TOOLS } from "./tools.js";
import { MAX_JOB_HOLD_MS } from "./hold.js";
import { CODE_TOOLS } from "./code-tools.js";

export { SHELL_INSTRUCTIONS, SHELL_SERVER_NAME, SHELL_SERVER_VERSION, SHELL_TOOLS };
export { CODE_TOOLS };

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

export async function callShellTool(
  backend: MachineBackend,
  name: string,
  args: unknown,
  options: { maxSyncWaitMs?: number; signal?: AbortSignal; codeOwner?: string } = {},
): Promise<unknown> {
  options.signal?.throwIfAborted();
  const codeTool = options.codeOwner ? CODE_TOOLS.find((item) => item.name === name) : undefined;
  const tool = codeTool ?? SHELL_TOOLS.find((item) => item.name === name);
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
  options.signal?.throwIfAborted();
  delete record.machine;
  delete record.sessionScope;
  const configured = options.maxSyncWaitMs;
  const holdMs = configured !== undefined && Number.isFinite(configured)
    ? Math.trunc(Math.min(MAX_JOB_HOLD_MS, Math.max(0, configured)))
    : MAX_JOB_HOLD_MS;
  const holdTimeout = holdMs + 5_000;
  if (codeTool?.op) {
    const params = {
      owner: options.codeOwner,
      ...(name === "execute" ? { code: record.code } : { executionId: record.executionId }),
      holdMs: record.wait === false ? 0 : holdMs,
    };
    const result = await backend.call(machine, codeTool.op, params, holdTimeout, options.signal);
    return isRecord(result) ? { ...result, machine } : result;
  }
  if (name === "run_command" || name === "run_tests") {
    const wait = record.wait !== false;
    delete record.wait;
    const deadline = Date.now() + holdMs;
    const started = await backend.call(machine, name === "run_tests" ? "shell_run_tests" : "shell_run", record, 20_000, options.signal);
    if (!wait) return started;
    if (!isRecord(started) || typeof started.jobId !== "string" || started.status !== "running") return started;
    const { jobId } = started;
    const guidance = started.guidance === undefined ? {} : { guidance: started.guidance };
    let last: unknown = started;
    const remaining = Math.max(0, Math.min(holdMs, deadline - Date.now()));
    if (remaining > 0) {
      options.signal?.throwIfAborted();
      try {
        last = await backend.call(machine, "shell_job", { jobId, holdMs: remaining }, remaining + 5_000, options.signal);
      } catch (error) {
        if (errorCode(error) !== "timeout") throw error;
      }
      if (isRecord(last) && typeof last.status === "string" && last.status !== "running") {
        const testResult = name === "run_tests" ? { passed: last.status === "exited" && last.exitCode === 0 } : {};
        return { ...last, ...guidance, ...testResult };
      }
    }
    return {
      ...started,
      ...(isRecord(last) ? last : {}),
      ...guidance,
      status: "running",
      jobId,
      hint: "The command is still running. Use get_job to wait or poll_output to read available output.",
    };
  }
  if (name === "get_job") record.holdMs = record.wait === false ? 0 : holdMs;
  if (name === "poll_output") record.view = "poll";
  if (!tool.op) throw new ToolError(`Tool ${name} has no op.`, "unknown_tool");
  const timeout = name === "git_commit_push" ? 90_000 : name === "get_job" ? holdTimeout : 20_000;
  const result = await backend.call(machine, tool.op, record, timeout, options.signal);
  if (name === "read_files" && isRecord(result) && typeof result.text === "string") return result.text;
  if (name === "read_file" && isRecord(result) && typeof result.coverage === "string" && typeof result.content === "string") {
    const { coverage, content, ...metadata } = result;
    const header = `${coverage}\n${JSON.stringify(metadata)}`;
    return metadata.fileComplete === true ? `${header}\n\n${content}` : `${header}\n\n${content}\n\n${coverage}`;
  }
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

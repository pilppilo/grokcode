import { randomBytes } from "node:crypto";
import { asRecord, errorCode, requiredString, ToolError } from "grokcode-shared";
import { runCode, type CodeRead } from "./code-sandbox.js";
import { MAX_JOB_HOLD_MS } from "./hold.js";

type State =
  | { status: "running" | "cancelled" | "timed_out" }
  | { status: "completed"; result: unknown }
  | { status: "failed"; error: string };

interface Execution {
  owner: string;
  executionId: string;
  controller: AbortController;
  state: State;
  expiresAt: number;
  waiters: Set<() => void>;
}

const RESULT_TTL = 10 * 60 * 1000;
const RUN_LIMIT = 120_000;

export class CodeExecutions {
  private readonly runs = new Map<string, Execution>();
  private active = 0;

  constructor(private readonly read: (...args: [...Parameters<CodeRead>, sessionScope?: string]) => Promise<unknown>) {}

  async dispatch(op: string, params: unknown, signal?: AbortSignal, sessionScope?: string) {
    signal?.throwIfAborted();
    const args = asRecord(params);
    const owner = requiredString(args.owner, "owner", 1_024);
    const now = Date.now();
    for (const [id, run] of this.runs) if (run.expiresAt <= now) this.runs.delete(id);
    const run = op === "shell_code_execute"
      ? this.start(owner, requiredString(args.code, "code", 8_192), sessionScope)
      : this.lookup(owner, requiredString(args.executionId, "executionId", 64));
    if (op === "shell_code_cancel") {
      this.abort(run, "cancelled");
    } else if (run.state.status === "running") {
      const hold = typeof args.holdMs === "number" && Number.isFinite(args.holdMs)
        ? Math.max(0, Math.min(MAX_JOB_HOLD_MS, Math.trunc(args.holdMs)))
        : MAX_JOB_HOLD_MS;
      if (hold > 0) await waitFor(run.waiters, hold, signal);
    }
    return { executionId: run.executionId, ...run.state };
  }

  cancelAll(): void {
    for (const run of this.runs.values()) this.abort(run, "cancelled");
  }

  private start(owner: string, code: string, sessionScope?: string): Execution {
    if (Buffer.byteLength(code) > 8_192) throw new ToolError("Code exceeds 8 KiB.", "code_limit");
    if (this.active >= 2) {
      throw new ToolError("Code execution capacity is full.", "busy");
    }
    if (this.runs.size >= 32) {
      const finished = [...this.runs.values()].find((run) => run.state.status !== "running");
      if (finished) this.runs.delete(finished.executionId);
    }
    const executionId = `exec_${randomBytes(16).toString("hex")}`;
    const controller = new AbortController();
    const run: Execution = { owner, executionId, controller, state: { status: "running" }, expiresAt: Infinity, waiters: new Set() };
    this.runs.set(executionId, run);
    this.active++;
    const timer = setTimeout(() => this.abort(run, "timed_out"), RUN_LIMIT);
    void runCode(code, (op, args, signal) => this.read(op, args, signal, sessionScope), controller.signal).then(
      (result) => { if (run.state.status === "running") run.state = { status: "completed", result }; },
      (error) => { if (run.state.status === "running") run.state = { status: "failed", error: errorCode(error) }; },
    ).finally(() => {
      clearTimeout(timer);
      this.active--;
      run.expiresAt = Date.now() + RESULT_TTL;
      controller.abort();
      for (const wake of run.waiters) wake();
    });
    return run;
  }

  private lookup(owner: string, id: string): Execution {
    const run = this.runs.get(id);
    if (!run || run.owner !== owner) throw new ToolError("Unknown code execution.", "execution_not_found");
    return run;
  }

  private abort(run: Execution, status: "cancelled" | "timed_out"): void {
    if (run.state.status !== "running") return;
    run.state = { status };
    run.controller.abort();
    for (const wake of run.waiters) wake();
  }
}

function waitFor(waiters: Set<() => void>, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      waiters.delete(finish);
    };
    const finish = () => {
      cleanup();
      resolve();
    };
    const abort = () => {
      cleanup();
      reject(signal?.reason);
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", abort, { once: true });
    waiters.add(finish);
    if (signal?.aborted) abort();
  });
}

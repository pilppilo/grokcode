import { randomBytes } from "node:crypto";

import { ToolError } from "grokcode-shared";

import { redact } from "./redact.js";
import type { SpawnFn, SpawnSpec } from "./spawn.js";

export interface JobView {
  jobId: string;
  status: "running" | "exited" | "timed_out";
  exitCode: number | null;
  startedAt: number;
  finishedAt?: number;
  argv: string[];
  cwd: string;
  output: string;
  truncated: boolean;
  timedOut: boolean;
}

interface Job extends JobView {
  raw: string;
  kill: () => void;
  timer?: ReturnType<typeof setTimeout>;
}

export class JobTable {
  private readonly jobs = new Map<string, Job>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxJobs = 32,
  ) {}

  start(spec: SpawnSpec, timeoutMs: number, maxOutput: number, spawnImpl: SpawnFn): JobView {
    this.evict();
    const running = [...this.jobs.values()].filter((job) => job.status === "running").length;
    if (running >= 8) throw new ToolError("too many commands are already running on this machine.", "busy");
    const spawned = spawnImpl(spec);
    const job: Job = {
      jobId: `job_${randomBytes(12).toString("hex")}`,
      status: "running",
      exitCode: null,
      startedAt: this.now(),
      argv: spec.shell ? [spec.command ?? ""] : [...spec.argv],
      cwd: spec.cwd,
      output: "",
      raw: "",
      truncated: false,
      timedOut: false,
      kill: () => spawned.kill("SIGTERM"),
    };
    const push = (chunk: string) => {
      if (job.truncated) return;
      job.raw += chunk;
      if (Buffer.byteLength(job.raw) > maxOutput) {
        job.raw = job.raw.slice(0, maxOutput);
        job.truncated = true;
        job.kill();
      }
      job.output = redact(job.raw);
    };
    spawned.stdout?.on("data", (chunk: string) => push(String(chunk)));
    spawned.stderr?.on("data", (chunk: string) => push(String(chunk)));
    job.timer = setTimeout(() => {
      if (job.status !== "running") return;
      job.status = "timed_out";
      job.timedOut = true;
      job.finishedAt = this.now();
      job.kill();
    }, timeoutMs);
    spawned.onExit((code) => {
      if (job.timer) clearTimeout(job.timer);
      if (job.status === "running") job.status = "exited";
      job.exitCode = code;
      job.finishedAt = job.finishedAt ?? this.now();
      job.output = redact(job.raw);
    });
    this.jobs.set(job.jobId, job);
    return this.view(job, false);
  }

  get(jobId: string): JobView {
    return this.view(this.take(jobId), false);
  }

  poll(jobId: string, offset: number): { jobId: string; offset: number; nextOffset: number; output: string; done: boolean; exitCode: number | null; status: JobView["status"]; truncated: boolean } {
    const job = this.take(jobId);
    const text = job.output;
    const start = Math.max(0, Math.min(offset, text.length));
    return {
      jobId: job.jobId,
      offset: start,
      nextOffset: text.length,
      output: text.slice(start),
      done: job.status !== "running",
      exitCode: job.exitCode,
      status: job.status,
      truncated: job.truncated,
    };
  }

  killAll(): void {
    for (const job of this.jobs.values()) {
      if (job.timer) clearTimeout(job.timer);
      if (job.status === "running") job.kill();
    }
  }

  private take(jobId: string): Job {
    const job = this.jobs.get(jobId);
    if (!job) throw new ToolError(`unknown job ${jobId}.`, "job_not_found");
    return job;
  }

  private view(job: Job, tail: boolean): JobView {
    const output = tail && job.output.length > 32_000 ? job.output.slice(-32_000) : job.output;
    return {
      jobId: job.jobId,
      status: job.status,
      exitCode: job.exitCode,
      startedAt: job.startedAt,
      ...(job.finishedAt != null ? { finishedAt: job.finishedAt } : {}),
      argv: job.argv,
      cwd: job.cwd,
      output,
      truncated: job.truncated,
      timedOut: job.timedOut,
    };
  }

  private evict(): void {
    if (this.jobs.size < this.maxJobs) return;
    const finished = [...this.jobs.values()]
      .filter((job) => job.status !== "running")
      .sort((a, b) => (a.finishedAt ?? a.startedAt) - (b.finishedAt ?? b.startedAt));
    const oldest = finished[0];
    if (oldest) this.jobs.delete(oldest.jobId);
  }
}

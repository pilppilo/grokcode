import { randomBytes } from "node:crypto";

import { ToolError } from "grokcode-shared";

import { redact } from "./redact.js";
import type { SpawnFn, SpawnSpec } from "./spawn.js";

export interface JobView {
  jobId: string;
  status: "running" | "exited" | "timed_out" | "cancelled";
  exitCode: number | null;
  startedAt: number;
  finishedAt?: number;
  argv: string[];
  cwd: string;
  output: string;
  nextOffset: number;
  truncated: boolean;
  timedOut: boolean;
}

interface Job extends Omit<JobView, "nextOffset"> {
  raw: string;
  finalized: boolean;
  kill: () => void | Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
}

/** Cut on a UTF-8 boundary so a multibyte character is not split. */
export function clipUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const buf = Buffer.from(text);
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buf[end - 1]! & 0xc0) === 0x80) end--;
  if (end > 0) {
    const lead = buf[end - 1]!;
    if (lead >= 0x80) {
      const width = lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
      end = end - 1 + width <= maxBytes ? end - 1 + width : end - 1;
    }
  }
  return buf.subarray(0, end).toString("utf8");
}

/** Hold the trailing partial line so a secret split across chunks is not published early. */
function visibleRaw(raw: string, done: boolean): string {
  if (done) return raw;
  const nl = raw.lastIndexOf("\n");
  if (nl === -1) return "";
  return raw.slice(0, nl + 1);
}

export class JobTable {
  private readonly jobs = new Map<string, Job>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxJobs = 32,
  ) {}

  start(spec: SpawnSpec, timeoutMs: number, maxOutput: number, spawnImpl: SpawnFn, keepTail = false): JobView {
    this.evict();
    const running = [...this.jobs.values()].filter((job) => !job.finalized).length;
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
      finalized: false,
      truncated: false,
      timedOut: false,
      kill: () => spawned.kill("SIGTERM"),
    };
    if (keepTail) maxOutput = Math.min(maxOutput, 16_000);
    const publish = (done: boolean) => {
      if (keepTail && !done) return;
      const raw = keepTail && job.truncated ? job.raw.slice(job.raw.includes("\n") ? job.raw.indexOf("\n") + 1 : job.raw.length) : job.raw;
      job.output = redact(visibleRaw(raw, done));
    };
    const push = (chunk: string) => {
      if (job.truncated && !keepTail) return;
      job.raw += chunk;
      if (Buffer.byteLength(job.raw) > maxOutput) {
        if (keepTail) {
          const bytes = Buffer.from(job.raw);
          job.raw = bytes.subarray(bytes.length - maxOutput).toString("utf8");
          job.truncated = true;
          return;
        }
        job.raw = clipUtf8(job.raw, maxOutput);
        job.truncated = true;
        void job.kill();
      }
      publish(false);
    };
    spawned.stdout?.on("data", (chunk: string) => push(String(chunk)));
    spawned.stderr?.on("data", (chunk: string) => push(String(chunk)));
    job.timer = setTimeout(() => {
      if (job.status !== "running") return;
      job.timedOut = true;
      void Promise.resolve(job.kill()).then(() => {
        if (job.status !== "running") return;
        job.status = "timed_out";
      });
    }, timeoutMs);
    spawned.onExit((code, _signal, error) => {
      if (error) push(error.message);
      if (job.timer) clearTimeout(job.timer);
      if (job.status === "running") job.status = job.timedOut ? "timed_out" : "exited";
      job.exitCode = code;
      job.finishedAt = job.finishedAt ?? this.now();
      publish(true);
      job.finalized = true;
    });
    this.jobs.set(job.jobId, job);
    return this.view(job);
  }

  get(jobId: string): JobView {
    return this.view(this.take(jobId));
  }

  cancel(jobId: string): JobView {
    const job = this.take(jobId);
    if (job.status === "running") {
      if (job.timer) clearTimeout(job.timer);
      job.status = "cancelled";
      job.kill();
    }
    return this.view(job);
  }

  poll(jobId: string, offset: number): { jobId: string; offset: number; nextOffset: number; output: string; done: boolean; exitCode: number | null; status: JobView["status"]; truncated: boolean } {
    const job = this.take(jobId);
    const text = job.output;
    const start = Math.max(0, Math.min(offset, text.length));
    const end = outputEnd(text, start);
    return {
      jobId: job.jobId,
      offset: start,
      nextOffset: end,
      output: text.slice(start, end),
      done: job.finalized && end === text.length,
      exitCode: job.exitCode,
      status: job.status,
      truncated: job.truncated,
    };
  }

  killAll(): void {
    for (const job of this.jobs.values()) {
      if (job.timer) clearTimeout(job.timer);
      if (!job.finalized && job.status === "running") job.kill();
    }
  }

  private take(jobId: string): Job {
    const job = this.jobs.get(jobId);
    if (!job) throw new ToolError(`unknown job ${jobId}.`, "job_not_found");
    return job;
  }

  private view(job: Job): JobView {
    const end = outputEnd(job.output, 0);
    return {
      jobId: job.jobId,
      status: job.status,
      exitCode: job.exitCode,
      startedAt: job.startedAt,
      ...(job.finishedAt != null ? { finishedAt: job.finishedAt } : {}),
      argv: job.argv.map((arg) => redact(arg)),
      cwd: job.cwd,
      output: job.output.slice(0, end),
      nextOffset: end,
      truncated: job.truncated,
      timedOut: job.timedOut,
    };
  }

  private evict(): void {
    if (this.jobs.size < this.maxJobs) return;
    const finished = [...this.jobs.values()]
      .filter((job) => job.finalized)
      .sort((a, b) => (a.finishedAt ?? a.startedAt) - (b.finishedAt ?? b.startedAt));
    const oldest = finished[0];
    if (oldest) this.jobs.delete(oldest.jobId);
  }
}

function outputEnd(text: string, start: number): number {
  const end = Math.min(text.length, start + 16_000);
  const last = text.charCodeAt(end - 1);
  return last >= 0xd800 && last <= 0xdbff && end < text.length ? end - 1 : end;
}

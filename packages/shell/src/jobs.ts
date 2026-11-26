import { randomBytes } from "node:crypto";
import { closeSync, readFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

import { ToolError } from "grokcode-shared";

import { redact } from "./redact.js";
import { cleanOutput, DEFAULT_OUTPUT_PREVIEW_BYTES, logPath, MAX_CAPTURE_BYTES, openOutput, saveOutput } from "./output.js";
import type { Spawned, SpawnFn, SpawnSpec } from "./spawn.js";

export interface JobView {
  jobId: string;
  status: "running" | "exited" | "timed_out" | "cancelled" | "output_limit";
  exitCode: number | null;
  startedAt: number;
  finishedAt?: number;
  argv: string[];
  cwd: string;
  output: string;
  outputOffset?: number;
  nextOffset: number;
  truncated: boolean;
  timedOut: boolean;
  omittedBytes?: number;
  headBytes?: number;
  outputFile?: string;
  outputSaveFailed?: boolean;
  captureLimitReached?: boolean;
}

interface Job extends Omit<JobView, "nextOffset"> {
  waiters: Set<() => void>;
  raw: string;
  sessionScope?: string;
  noticed?: boolean;
  finalized: boolean;
  kill: () => Promise<void>;
  sendInput?: Spawned["sendInput"];
  cancelling?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  capture?: {
    chunks: string[];
    bytes: number;
    previewBytes: number;
    headBytes: number;
    omittedBytes: number;
  };
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

function redactOutput(raw: string): string {
  return redact(raw).replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*/, "[REDACTED-PRIVATE-KEY]");
}

export class JobTable {
  private readonly jobs = new Map<string, Job>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxJobs = 32,
    private readonly outputDir?: string,
  ) {}

  start(spec: SpawnSpec, timeoutMs: number, maxOutput: number, spawnImpl: SpawnFn, keepTail = false, onChange?: (view: JobView) => void, onOutput?: (chunk: Buffer | string) => void, previewBytes = DEFAULT_OUTPUT_PREVIEW_BYTES, sessionScope?: string): JobView {
    this.evict();
    const running = [...this.jobs.values()].filter((job) => !job.finalized).length;
    if (running >= 8) throw new ToolError("too many commands are already running on this machine.", "busy");
    const spawned = spawnImpl(spec);
    const job: Job = {
      jobId: `job_${randomBytes(12).toString("hex")}`,
      sessionScope,
      status: "running",
      exitCode: null,
      startedAt: this.now(),
      argv: spec.shell ? [spec.command ?? ""] : [...spec.argv],
      cwd: spec.cwd,
      output: "",
      raw: "",
      finalized: false,
      waiters: new Set(),
      truncated: false,
      timedOut: false,
      kill: async () => spawned.kill("SIGTERM"),
      sendInput: spec.stdin ? spawned.sendInput?.bind(spawned) : undefined,
    };
    if (this.outputDir && !onOutput) {
      job.capture = { chunks: [], bytes: 0, previewBytes: Math.min(previewBytes, Math.floor(maxOutput / 2)), omittedBytes: 0, headBytes: 0 };
    }
    if (keepTail) maxOutput = Math.min(maxOutput, 16_000);
    let discardPartialLine = false;
    let discardPrivateKey = false;
    const skipPrivateKey = (text: string) => {
      const end = /-----END [A-Z0-9 ]*PRIVATE KEY-----[^\n]*\n/.exec(text);
      discardPrivateKey = !end;
      return end ? text.slice(end.index + end[0].length) : text.slice(-256);
    };
    const publish = (done: boolean) => {
      job.output = discardPrivateKey ? "" : redactOutput(visibleRaw(job.raw, done));
    };
    const push = (chunk: Buffer | string) => {
      const capture = job.capture;
      if (capture) {
        if (capture.bytes > MAX_CAPTURE_BYTES || !chunk.length) return;
        const text = String(chunk);
        capture.bytes += Buffer.byteLength(text);
        if (capture.bytes > MAX_CAPTURE_BYTES) {
          // Keep only complete lines from earlier chunks when capture is interrupted.
          if (job.status === "running" && !job.timedOut) {
            job.status = "output_limit";
            void job.kill().catch(() => {});
          }
          return;
        }
        capture.chunks.push(text);
        return;
      }
      onOutput?.(chunk);
      if (job.truncated && !keepTail) return;
      let text = String(chunk);
      if (discardPrivateKey) {
        text = skipPrivateKey(job.raw + text);
        if (discardPrivateKey) {
          job.raw = text;
          return;
        }
        job.raw = "";
      }
      if (discardPartialLine) {
        const newline = text.indexOf("\n");
        if (newline === -1) return;
        text = text.slice(newline + 1);
        discardPartialLine = false;
      }
      job.raw += text;
      if (Buffer.byteLength(job.raw) > maxOutput) {
        if (keepTail) {
          const bytes = Buffer.from(job.raw);
          // Drop whole lines so a clipped credential cannot appear without its prefix.
          const start = bytes.indexOf(10, bytes.length - maxOutput - 1);
          const dropped = start === -1 ? job.raw : bytes.subarray(0, start + 1).toString("utf8");
          const lastPrivateKeyMarker = [...dropped.matchAll(/-----(BEGIN|END) [A-Z0-9 ]*PRIVATE KEY-----/g)].at(-1);
          discardPrivateKey = lastPrivateKeyMarker?.[1] === "BEGIN";
          job.outputOffset = (job.outputOffset ?? 0) + redactOutput(visibleRaw(dropped, false)).length;
          job.raw = start === -1 ? "" : bytes.subarray(start + 1).toString("utf8");
          discardPartialLine = start === -1 && !discardPrivateKey;
          job.truncated = true;
          if (discardPrivateKey) job.raw = skipPrivateKey(job.raw);
        } else {
          job.raw = clipUtf8(job.raw, maxOutput);
          job.truncated = true;
          if (job.status === "running" && !job.timedOut) {
            job.status = "output_limit";
            void job.kill().catch(() => {});
          }
        }
      }
      publish(false);
    };
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    spawned.stdout?.on("data", (chunk: Buffer | string) => push(job.capture && Buffer.isBuffer(chunk) ? stdoutDecoder.write(chunk) : chunk));
    spawned.stderr?.on("data", (chunk: Buffer | string) => push(job.capture && Buffer.isBuffer(chunk) ? stderrDecoder.write(chunk) : chunk));
    job.timer = setTimeout(() => {
      if (job.status !== "running") return;
      job.timedOut = true;
      void Promise.resolve(job.kill()).then(() => {
        if (job.status !== "running") return;
        job.status = "timed_out";
      }).catch(() => {});
    }, timeoutMs);
    const finish: Parameters<Spawned["onExit"]>[0] = (code, _signal, error) => {
      if (job.capture) {
        push(stdoutDecoder.end());
        push(stderrDecoder.end());
      }
      if (error) push(error.message);
      if (job.timer) clearTimeout(job.timer);
      if (job.status === "running") job.status = job.timedOut ? "timed_out" : "exited";
      job.exitCode = code;
      job.finishedAt = job.finishedAt ?? this.now();
      if (job.capture && this.outputDir) {
        const complete = cleanOutput(visibleRaw(job.capture.chunks.join(""), job.capture.bytes <= MAX_CAPTURE_BYTES));
        this.setPreview(job, complete);
        job.capture.chunks = [];
        try {
          saveOutput(this.outputDir, job.jobId, complete);
          job.outputFile = `grokcode-output:${job.jobId}`;
        } catch {
          job.outputSaveFailed = true;
        }
      } else {
        publish(true);
      }
      job.finalized = true;
      for (const wake of job.waiters) wake();
      onChange?.(this.view(job));
    };
    spawned.onExit((...args) => {
      if (job.cancelling) void job.cancelling.then(() => finish(...args), () => finish(...args));
      else finish(...args);
    });
    this.jobs.set(job.jobId, job);
    return this.view(job);
  }

  list(sessionScope?: string) {
    const jobs = [];
    const notices = [];
    for (const job of this.jobs.values()) {
      if (job.sessionScope !== sessionScope) continue;
      const { jobId, status, startedAt, finishedAt, exitCode } = job;
      jobs.push({ jobId, status, startedAt, finishedAt, exitCode });
      if (job.finalized && !job.noticed) {
        notices.push({ jobId, status, exitCode });
        job.noticed = true;
      }
    }
    return { jobs, notices };
  }

  get(jobId: string, sessionScope?: string): JobView {
    return this.view(this.take(jobId, sessionScope));
  }

  savedOutput(jobId: string, sessionScope?: string): { file: string; cwd: string } {
    const job = this.take(jobId, sessionScope);
    if (!this.outputDir || !job.outputFile) throw new ToolError("Output log is unavailable.", "output_unavailable");
    return { file: logPath(this.outputDir, job.jobId), cwd: job.cwd };
  }

  async wait(jobId: string, holdMs: number, signal?: AbortSignal, sessionScope?: string): Promise<JobView> {
    signal?.throwIfAborted();
    const job = this.take(jobId, sessionScope);
    if (holdMs === 0 || job.finalized || job.status === "cancelled") return this.view(job);
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        job.waiters.delete(wake);
        signal?.removeEventListener("abort", abort);
      };
      const wake = () => {
        cleanup();
        resolve();
      };
      const abort = () => {
        cleanup();
        reject(signal?.reason);
      };
      const timer = setTimeout(wake, holdMs);
      job.waiters.add(wake);
      signal?.addEventListener("abort", abort, { once: true });
    });
    return this.view(job);
  }

  async sendInput(jobId: string, input: string, beforeWrite: () => void, sessionScope?: string): Promise<void> {
    const job = this.take(jobId, sessionScope);
    if (job.status !== "running" || job.cancelling || !job.sendInput) {
      throw new ToolError("This job has no open stdin.", "input_unavailable");
    }
    beforeWrite();
    await job.sendInput(input);
  }

  async cancel(jobId: string, sessionScope?: string): Promise<JobView> {
    const job = this.take(jobId, sessionScope);
    if (job.status === "running" || job.cancelling) {
      job.cancelling ??= Promise.resolve().then(() => job.kill()).then(() => {
        if (job.timer) clearTimeout(job.timer);
        job.status = "cancelled";
        for (const wake of job.waiters) wake();
      }).finally(() => { job.cancelling = undefined; });
      await job.cancelling;
    }
    return this.view(job);
  }

  poll(jobId: string, offset: number, sessionScope?: string): { jobId: string; offset: number; nextOffset: number; output: string; done: boolean; exitCode: number | null; status: JobView["status"]; truncated: boolean } {
    const job = this.take(jobId, sessionScope);
    let text = job.output;
    if (job.capture) {
      if (!job.finalized) {
        text = cleanOutput(visibleRaw(job.capture.chunks.join(""), false));
      } else if (job.outputFile && this.outputDir) {
        const fd = openOutput(this.outputDir, job.jobId);
        try { text = readFileSync(fd, "utf8"); } finally { closeSync(fd); }
      } else if (job.capture.omittedBytes > 0) {
        throw new ToolError("Full output could not be saved.", "output_unavailable");
      }
    }
    const base = job.outputOffset ?? 0;
    const start = Math.max(0, Math.min(offset - base, text.length));
    const pollBytes = job.capture ? 2 * job.capture.previewBytes : undefined;
    const end = pollBytes === undefined
      ? outputEnd(text, start)
      : start + clipUtf8(text.slice(start, start + pollBytes + 1), pollBytes).length;
    if (end === start && start < text.length) {
      throw new ToolError("Output preview budget is too small for the next character. Read outputFile instead.", "too_large");
    }
    return {
      jobId: job.jobId,
      offset: base + start,
      nextOffset: base + end,
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
      if (!job.finalized && job.status === "running") void job.kill().catch(() => {});
    }
  }

  private take(jobId: string, sessionScope?: string): Job {
    const job = this.jobs.get(jobId);
    if (!job || job.sessionScope !== sessionScope) throw new ToolError(`unknown job ${jobId}.`, "job_not_found");
    return job;
  }

  private view(job: Job): JobView {
    if (job.capture && !job.finalized) this.setPreview(job, cleanOutput(visibleRaw(job.capture.chunks.join(""), false)));
    const end = job.capture ? job.output.length : outputEnd(job.output, 0);
    return {
      jobId: job.jobId,
      status: job.status,
      exitCode: job.exitCode,
      startedAt: job.startedAt,
      ...(job.finishedAt != null ? { finishedAt: job.finishedAt } : {}),
      argv: job.argv.map((arg) => redact(arg)),
      cwd: job.cwd,
      output: job.output.slice(0, end),
      ...(job.outputOffset === undefined ? {} : { outputOffset: job.outputOffset }),
      nextOffset: job.capture?.omittedBytes ? clipUtf8(job.output, job.capture.headBytes).length : (job.outputOffset ?? 0) + end,
      truncated: job.truncated,
      timedOut: job.timedOut,
      ...(job.capture ? { omittedBytes: job.capture.omittedBytes, headBytes: job.capture.headBytes } : {}),
      ...(job.outputFile ? { outputFile: job.outputFile } : {}),
      ...(job.outputSaveFailed ? { outputSaveFailed: true } : {}),
      ...(job.capture && job.capture.bytes > MAX_CAPTURE_BYTES ? { captureLimitReached: true } : {}),
    };
  }

  private setPreview(job: Job, text: string): void {
    const capture = job.capture!;
    const bytes = Buffer.from(text);
    const cap = capture.previewBytes;
    if (bytes.length <= 2 * cap) {
      job.output = text;
      capture.headBytes = bytes.length;
      capture.omittedBytes = 0;
    } else {
      const head = clipUtf8(text, cap);
      let tail = bytes.length - cap;
      while (tail < bytes.length && (bytes[tail]! & 0xc0) === 0x80) tail++;
      job.output = head + bytes.subarray(tail).toString("utf8");
      capture.headBytes = Buffer.byteLength(head);
      capture.omittedBytes = tail - capture.headBytes;
    }
    job.truncated = capture.omittedBytes > 0 || capture.bytes > MAX_CAPTURE_BYTES;
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

import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, statSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { ToolError } from "grokcode-shared";

import type { JobTable, JobView } from "./jobs.js";

interface StoredTask {
  project: string;
  command: string;
  logIncomplete?: boolean;
  job?: Pick<JobView, "status" | "exitCode" | "finishedAt" | "output" | "truncated">;
}

export class TaskStore {
  private readonly unsaved = new Map<string, StoredTask>();
  private readonly active = new Map<string, string>();

  constructor(private readonly directory: string, private readonly jobs: JobTable) {}

  async start(project: string, command: string, launch: (publish: (job: JobView) => void, capture: (chunk: Buffer | string) => void) => Promise<JobView>) {
    const taskId = `task_${randomBytes(12).toString("hex")}`;
    this.save(taskId, { project, command });
    const log = this.file(taskId, "log");
    let logIncomplete = false;
    const capture = (chunk: Buffer | string) => {
      if (logIncomplete) return;
      try {
        appendFileSync(log, chunk, { mode: 0o600 });
      } catch {
        logIncomplete = true;
      }
    };
    const finish = (job: JobView) => {
      this.active.delete(taskId);
      const { status, exitCode, finishedAt, output, truncated } = job;
      const stored = { project, command, logIncomplete, job: { status, exitCode, ...(finishedAt === undefined ? {} : { finishedAt }), output, truncated } };
      try {
        this.save(taskId, stored);
      } catch {
        this.unsaved.set(taskId, stored);
      }
    };
    let job: JobView;
    try {
      job = await launch(finish, capture);
    } catch (error) {
      try { rmSync(this.file(taskId), { force: true }); } catch { /* preserve the launch error */ }
      throw error;
    }
    if (job.finishedAt === undefined) this.active.set(taskId, job.jobId);
    return this.status(taskId);
  }

  status(taskId: string) {
    const { project, command, job, live } = this.lookup(taskId);
    const phase = job && (live || job.finishedAt !== undefined) ? job.status : "interrupted";
    return {
      taskId, project, phase,
      done: !live,
      exitCode: job?.exitCode ?? null,
      steps: [{ name: command, phase }],
      filesTouched: null,
    };
  }

  activity(taskId: string, offset: number) {
    const { job, logIncomplete } = this.lookup(taskId);
    const summary = this.status(taskId);
    const tail = job?.output ?? "";
    const start = Math.min(offset, tail.length);
    const logBytes = statSync(this.file(taskId, "log"), { throwIfNoEntry: false })?.size ?? 0;
    return { ...summary, logBytes, logIncomplete: logIncomplete ?? false, offset: start, nextOffset: tail.length, tail: tail.slice(start), truncated: job?.truncated ?? false };
  }

  cancel(taskId: string) {
    this.lookup(taskId);
    const jobId = this.active.get(taskId);
    if (jobId) this.jobs.cancel(jobId);
    return this.status(taskId);
  }

  private lookup(taskId: string) {
    if (!/^task_[0-9a-f]{24}$/.test(taskId)) throw new ToolError("Invalid task ID.", "invalid_argument");
    let stored: StoredTask;
    try {
      stored = this.unsaved.get(taskId) ?? JSON.parse(readFileSync(this.file(taskId), "utf8")) as StoredTask;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ToolError("Unknown task.", "task_not_found");
      throw new ToolError("Task state could not be read.", "task_unavailable");
    }
    const jobId = this.active.get(taskId);
    return { ...stored, job: jobId ? this.jobs.get(jobId) : stored.job, live: jobId !== undefined };
  }

  private save(taskId: string, stored: StoredTask) {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const file = this.file(taskId);
    writeFileSync(`${file}.tmp`, JSON.stringify(stored), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }

  private file(taskId: string, extension = "json") {
    return path.join(this.directory, `${taskId}.${extension}`);
  }
}

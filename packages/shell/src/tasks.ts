import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, statSync, readFileSync, renameSync, rmSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import path from "node:path";

import { ToolError } from "grokcode-shared";

import { isSensitivePath } from "./confine.js";
import type { JobTable, JobView } from "./jobs.js";

interface StoredTask {
  sessionScope?: string;
  project: string;
  command: string;
  logIncomplete?: boolean;
  filesTouched?: string[];
  filesTouchedIncomplete?: boolean;
  job?: Pick<JobView, "status" | "exitCode" | "finishedAt" | "output" | "outputOffset" | "truncated">;
}

export class TaskStore {
  private readonly unsaved = new Map<string, StoredTask>();
  private readonly active = new Map<string, string>();

  constructor(private readonly directory: string, private readonly jobs: JobTable) {}

  async start(project: string, command: string, launch: (publish: (job: JobView) => void, capture: (chunk: Buffer | string) => void) => Promise<JobView>, root?: string, sessionScope?: string) {
    const taskId = `task_${randomBytes(12).toString("hex")}`;
    this.save(taskId, { project, command, sessionScope });
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
    const changed = new Set<string>();
    let watchIncomplete = false;
    let watcher: FSWatcher | undefined;
    if (root) {
      try {
        watcher = watch(root, { recursive: true, persistent: false }, (_event, file) => {
          if (!file) { watchIncomplete = true; return; }
          const relative = path.relative(root, path.resolve(root, file));
          if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) return;
          if (isSensitivePath(path.join(root, relative), process.platform === "win32" ? "win32" : "posix")) return;
          if (changed.size < 256) changed.add(relative);
          else if (!changed.has(relative)) watchIncomplete = true;
        });
        watcher.on("error", () => { watchIncomplete = true; });
      } catch {
        watchIncomplete = true;
      }
    }
    const finish = (job: JobView) => {
      watcher?.close();
      this.active.delete(taskId);
      const { status, exitCode, finishedAt, output, outputOffset, truncated } = job;
      const stored = { project, command, sessionScope, logIncomplete, filesTouched: [...changed].sort(), filesTouchedIncomplete: watchIncomplete, job: { status, exitCode, ...(finishedAt === undefined ? {} : { finishedAt }), output, ...(outputOffset === undefined ? {} : { outputOffset }), truncated } };
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
      watcher?.close();
      try { rmSync(this.file(taskId), { force: true }); } catch { /* preserve the launch error */ }
      throw error;
    }
    if (job.finishedAt === undefined) this.active.set(taskId, job.jobId);
    return this.status(taskId, sessionScope);
  }

  status(taskId: string, sessionScope?: string) {
    const { project, command, job, live, filesTouched, filesTouchedIncomplete } = this.lookup(taskId, sessionScope);
    const phase = job && (live || job.finishedAt !== undefined) ? job.status : "interrupted";
    return {
      taskId, project, phase,
      done: !live,
      exitCode: job?.exitCode ?? null,
      steps: [{ name: command, phase }],
      filesTouched: filesTouched ?? null,
      filesTouchedIncomplete: filesTouchedIncomplete ?? (job?.finishedAt === undefined),
    };
  }

  activity(taskId: string, offset: number, sessionScope?: string) {
    const { job, logIncomplete } = this.lookup(taskId, sessionScope);
    const summary = this.status(taskId, sessionScope);
    const tail = job?.output ?? "";
    const base = job?.outputOffset ?? 0;
    const start = Math.max(0, Math.min(offset - base, tail.length));
    const logBytes = statSync(this.file(taskId, "log"), { throwIfNoEntry: false })?.size ?? 0;
    return { ...summary, logBytes, logIncomplete: logIncomplete ?? false, offset: base + start, nextOffset: base + tail.length, tail: tail.slice(start), truncated: job?.truncated ?? false };
  }

  async cancel(taskId: string, sessionScope?: string) {
    this.lookup(taskId, sessionScope);
    const jobId = this.active.get(taskId);
    if (jobId) await this.jobs.cancel(jobId, sessionScope);
    return this.status(taskId, sessionScope);
  }

  private lookup(taskId: string, sessionScope?: string) {
    if (!/^task_[0-9a-f]{24}$/.test(taskId)) throw new ToolError("Invalid task ID.", "invalid_argument");
    let stored: StoredTask;
    try {
      stored = this.unsaved.get(taskId) ?? JSON.parse(readFileSync(this.file(taskId), "utf8")) as StoredTask;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ToolError("Unknown task.", "task_not_found");
      throw new ToolError("Task state could not be read.", "task_unavailable");
    }
    const jobId = this.active.get(taskId);
    if (stored.sessionScope !== sessionScope) throw new ToolError("Unknown task.", "task_not_found");
    return { ...stored, job: jobId ? this.jobs.get(jobId, sessionScope) : stored.job, live: jobId !== undefined };
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

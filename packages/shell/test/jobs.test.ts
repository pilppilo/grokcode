import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { TaskStore } from "../src/tasks.ts";
import { JobTable } from "../src/jobs.ts";
import type { Spawned } from "../src/spawn.ts";

test("cancelling a job keeps polling open until the final partial line is available", () => {
  const jobs = new JobTable();
  const stdout = new PassThrough();
  let finish: Parameters<Spawned["onExit"]>[0] | undefined;
  const job = jobs.start({ argv: ["echo"], cwd: "/tmp", shell: false }, 10_000, 4096, () => ({
    stdout,
    stderr: null,
    kill: () => {},
    onExit: (listener) => { finish = listener; },
  }));
  stdout.write("last line");
  assert.equal(jobs.cancel(job.jobId).status, "cancelled");
  const pending = jobs.poll(job.jobId, 0);
  assert.equal(pending.done, false);
  assert.equal(pending.output, "");

  assert.ok(finish);
  finish(null, "SIGTERM");
  const completed = jobs.poll(job.jobId, pending.nextOffset);
  assert.equal(completed.done, true);
  assert.equal(completed.output, "last line");
});

test("task cancellation waits for final output and persists the result", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "grokcode-task-cancel-"));
  const jobs = new JobTable();
  const tasks = new TaskStore(dir, jobs);
  const stdout = new PassThrough();
  let finish: Parameters<Spawned["onExit"]>[0] | undefined;
  try {
    const started = await tasks.start("app", "test", async (publish) =>
      jobs.start({ argv: ["echo"], cwd: dir, shell: false }, 10_000, 4096, () => ({
        stdout,
        stderr: null,
        kill: () => {},
        onExit: (listener) => { finish = listener; },
      }), true, publish),
    );
    assert.equal(started.phase, "running");
    assert.equal(new TaskStore(dir, new JobTable()).status(started.taskId).phase, "interrupted");
    stdout.write("last line");
    assert.equal(tasks.cancel(started.taskId).done, false);
    assert.equal(tasks.activity(started.taskId, 0).done, false);
    assert.ok(finish);
    finish(null, "SIGTERM");
    const completed = tasks.activity(started.taskId, 0);
    assert.equal(completed.done, true);
    assert.equal(completed.phase, "cancelled");
    assert.equal(completed.tail, "last line");
    assert.deepEqual(new TaskStore(dir, new JobTable()).activity(started.taskId, 0), completed);
  } finally {
    jobs.killAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

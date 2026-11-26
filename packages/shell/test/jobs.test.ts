import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { TaskStore } from "../src/tasks.ts";
import { JobTable } from "../src/jobs.ts";
import { defaultSpawn, type Spawned } from "../src/spawn.ts";

test("kill_job terminates a child and grandchild", { timeout: 15_000 }, async () => {
  const jobs = new JobTable();
  const spawnCode = "const {spawn}=require('node:child_process');";
  const grandchildCode = "console.log(process.pid); setTimeout(() => process.exit(), 8000);";
  const childCode = spawnCode + "console.log(process.pid);" +
    "spawn(process.execPath, ['-e', " + JSON.stringify(grandchildCode) + "], {stdio: 'inherit'});";
  const parentCode = spawnCode + "console.log(process.pid);" +
    "spawn(process.execPath, ['-e', " + JSON.stringify(childCode) + "], {stdio: 'inherit'});" +
    "setTimeout(() => process.exit(), 8000);";
  const job = jobs.start({
    argv: [process.execPath, "-e", parentCode], cwd: process.cwd(),
    platform: process.platform === "win32" ? "win32" : "posix", shell: false,
  }, 12_000, 4096, defaultSpawn);
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      // An orphaned zombie has exited and only awaits reaping by the OS.
      return process.platform !== "linux" || !/\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
    } catch (error) {
      if (["ESRCH", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
      throw error;
    }
  };
  try {
    let pids: number[] = [];
    for (let i = 0; i < 200 && pids.length < 3; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      pids = jobs.get(job.jobId).output.trim().split(/\s+/).filter(Boolean).map(Number);
    }
    assert.equal(pids.length, 3);
    assert.ok(pids.every(alive));
    assert.equal((await jobs.cancel(job.jobId)).status, "cancelled");
    for (let i = 0; i < 80 && pids.some(alive); i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.deepEqual(pids.filter(alive), []);
  } finally {
    jobs.killAll();
  }
});

test("job holds return on expiry, process timeout, cancellation and abort", async () => {
  const jobs = new JobTable();
  const stdout = new PassThrough();
  let finish!: Parameters<Spawned["onExit"]>[0];
  const start = (timeout: number) => jobs.start({ argv: ["echo"], cwd: "/tmp", shell: false }, timeout, 4096, () => ({
    stdout, stderr: null, kill: () => finish(null, "SIGTERM"),
    onExit: (listener) => { finish = listener; },
  }));

  const job = start(10_000);
  assert.equal((await jobs.wait(job.jobId, 1)).status, "running");
  const controller = new AbortController();
  const aborted = jobs.wait(job.jobId, 45_000, controller.signal);
  controller.abort();
  await assert.rejects(aborted, { name: "AbortError" });
  assert.equal(jobs.get(job.jobId).status, "running");

  const cancelled = jobs.wait(job.jobId, 45_000);
  await jobs.cancel(job.jobId);
  assert.equal((await cancelled).status, "cancelled");

  const slow = start(5);
  assert.equal((await jobs.wait(slow.jobId, 45_000)).status, "timed_out");
});

test("jobs report output-limit termination distinctly", () => {
  const jobs = new JobTable();
  const stdout = new PassThrough();
  let finish!: Parameters<Spawned["onExit"]>[0];
  let killed = 0;
  const job = jobs.start({ argv: ["echo"], cwd: "/tmp", shell: false }, 10_000, 32, () => ({
    stdout, stderr: null, kill: () => { killed++; }, onExit: (listener) => { finish = listener; },
  }));
  stdout.write("x".repeat(1_000));
  assert.equal(killed, 1);
  assert.equal(jobs.poll(job.jobId, 0).done, false);
  finish(null, "SIGTERM");
  const result = jobs.poll(job.jobId, 0);
  assert.equal(result.status, "output_limit");
  assert.equal(result.done, true);
  assert.equal(result.truncated, true);
});

test("rolling tails publish redacted live output and keep final errors after overflow", () => {
  const jobs = new JobTable();
  const stdout = new PassThrough();
  let finish!: Parameters<Spawned["onExit"]>[0];
  const job = jobs.start({ argv: ["echo"], cwd: "/tmp", shell: false }, 10_000, 64, () => ({
    stdout, stderr: null, kill: () => assert.fail("rolling output must not kill the job"),
    onExit: (listener) => { finish = listener; },
  }), true);
  stdout.write("first line\npassword=secret-");
  const first = jobs.poll(job.jobId, 0);
  assert.equal(first.output, "first line\n");
  stdout.write("value\n");
  const second = jobs.poll(job.jobId, first.nextOffset);
  assert.equal(second.output, "password=[REDACTED]\n");
  stdout.write("verbose output\n".repeat(20) + "final error");
  assert.match(jobs.poll(job.jobId, second.nextOffset).output, /verbose output/);
  finish(1, null);
  const result = jobs.poll(job.jobId, second.nextOffset);
  assert.equal(result.status, "exited");
  assert.equal(result.exitCode, 1);
  assert.equal(result.truncated, true);
  assert.match(result.output, /final error$/);
});

test("cancelling a job keeps polling open until the final partial line is available", async () => {
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
  assert.equal((await jobs.cancel(job.jobId)).status, "cancelled");
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
    assert.equal((await tasks.cancel(started.taskId)).done, false);
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

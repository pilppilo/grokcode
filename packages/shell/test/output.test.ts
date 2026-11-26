import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { createShellRuntime } from "../src/execute.js";
import { JobTable } from "../src/jobs.js";
import { MAX_CAPTURE_BYTES } from "../src/output.js";
import { parsePolicy } from "../src/policy.js";
import type { Spawned } from "../src/spawn.js";

test("job output keeps a byte-bounded head and tail and saves the full sanitized stream", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "grokcode-output-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const outputs = path.join(dir, "outputs");
  const root = path.join(dir, "project");
  mkdirSync(outputs);
  mkdirSync(root);
  const expired = path.join(outputs, `job_${"a".repeat(24)}.log`);
  writeFileSync(expired, "old");
  utimesSync(expired, new Date(0), new Date(0));
  const jobs = new JobTable(Date.now, 32, outputs);
  const stdout = new PassThrough();
  let finish!: Parameters<Spawned["onExit"]>[0];
  const job = jobs.start({ argv: ["fixture"], cwd: root, shell: false }, 10_000, 200_000, () => ({
    stdout, stderr: null, kill: () => assert.fail("preview truncation killed the job"),
    onExit: (listener) => { finish = listener; },
  }), false, undefined, undefined, 1_024);
  const middle = "🙂".repeat(65_000);
  const raw = Buffer.from(`\x1b[31mstart\x1b[0m\npassword=demo-secret-pattern\n${middle}\nend🙂`);
  for (let offset = 0; offset < raw.length; offset += 4_093) stdout.write(raw.subarray(offset, offset + 4_093));
  finish(7, null);

  const complete = `start\npassword=[REDACTED]\n${middle}\nend🙂`;
  const view = jobs.get(job.jobId);
  assert.equal(view.status, "exited");
  assert.equal(view.exitCode, 7);
  assert.ok(view.output.startsWith("start\npassword=[REDACTED]"));
  assert.ok(view.output.endsWith("\nend🙂"));
  assert.ok(Buffer.byteLength(view.output) <= 2_048);
  assert.equal(view.omittedBytes, Buffer.byteLength(complete) - Buffer.byteLength(view.output));
  assert.ok(view.outputFile);
  const log = jobs.savedOutput(job.jobId).file;
  assert.equal(readFileSync(log, "utf8"), complete);
  assert.equal(existsSync(expired), false);
  assert.ok(Buffer.byteLength(jobs.poll(job.jobId, 0).output) <= 2_048);

  const platform = process.platform === "win32" ? "win32" : "posix";
  const policy = parsePolicy(JSON.stringify({ version: 1, roots: [root], allow: [] }), platform, dir);
  const runtime = createShellRuntime({ platform, home: dir, jobs, outputDir: outputs, loadPolicy: () => ({ policy, source: "test" }) });
  await assert.rejects(runtime.execute("shell_read_file", { path: log }), /outside the allowed roots/);
  await assert.rejects(runtime.execute("shell_read_file", { path: "grokcode-output:../other" }), /unknown job/);

  const parts: string[] = [];
  let offset = 0;
  for (;;) {
    const page = await runtime.execute("shell_read_file", { path: view.outputFile, offset }) as {
      path: string; content: string; hasMore: boolean; nextOffset: number;
    };
    assert.equal(page.path, view.outputFile);
    assert.ok(Buffer.byteLength(page.content) <= 46_000);
    parts.push(page.content);
    if (!page.hasMore) break;
    assert.ok(page.nextOffset > offset);
    offset = page.nextOffset;
  }
  assert.equal(parts.join(""), complete);
});

test("the capture ceiling stops the command and reports a partial saved log", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "grokcode-output-limit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const jobs = new JobTable(Date.now, 32, dir);
  const stdout = new PassThrough();
  let finish!: Parameters<Spawned["onExit"]>[0];
  let kills = 0;
  const job = jobs.start({ argv: ["fixture"], cwd: dir, shell: false }, 10_000, 20_480, () => ({
    stdout, stderr: null, kill: () => { kills++; },
    onExit: (listener) => { finish = listener; },
  }));
  stdout.write("complete line\nunpublished fragment");
  stdout.write(Buffer.alloc(MAX_CAPTURE_BYTES, 120));
  assert.equal(kills, 1);
  finish(null, "SIGTERM");
  const view = jobs.get(job.jobId);
  assert.equal(view.status, "output_limit");
  assert.equal(view.captureLimitReached, true);
  assert.equal(view.truncated, true);
  assert.equal(readFileSync(jobs.savedOutput(job.jobId).file, "utf8"), "complete line\n");
});

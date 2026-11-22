import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

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

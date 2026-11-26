import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CodeExecutions } from "../src/code-executions.js";
import { runCode } from "../src/code-sandbox.js";
import { createShellRuntime } from "../src/execute.js";
import { parsePolicy } from "../src/policy.js";

test("sandbox composes async reads, exposes no host APIs, and enforces CPU and result limits", async () => {
  const { signal } = new AbortController();
  const read = async (op: string) => op;
  const result = await runCode(`
    return {
      apis: [typeof process, typeof require, typeof fetch, typeof setTimeout, typeof Date, typeof tools.write_file],
      reads: await Promise.all([tools.read_file({}), tools.list_dir({})])
    };
  `, read, signal);
  assert.deepEqual(result, {
    apis: Array(6).fill("undefined"),
    reads: ["shell_read_file", "shell_list_dir"],
  });
  await assert.rejects(runCode('return await import("node:fs")', read, signal), /script rejected/i);
  await assert.rejects(runCode("while (true) {}", read, signal), /script rejected|sandbox limit/i);
  await assert.rejects(runCode('return "x".repeat(33000)', read, signal), /exceeds 32 KiB/);
});

test("executions hold, can be cancelled, and are isolated by owner", { timeout: 3_000 }, async () => {
  let entered!: () => void;
  const reading = new Promise<void>((resolve) => { entered = resolve; });
  let readAborted = false;
  const runs = new CodeExecutions(async (_op, _args, signal) => {
    entered();
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        readAborted = true;
        reject(signal.reason);
      }, { once: true });
    });
  });
  const owner = "owner";
  const started = await runs.dispatch("shell_code_execute", { code: "return await tools.read_file({})", holdMs: 0, owner });
  assert.equal(started.status, "running");
  await reading;
  const { executionId } = started;
  assert.equal((await runs.dispatch("shell_code_poll", { owner, executionId, holdMs: 1 })).status, "running");
  const held = runs.dispatch("shell_code_poll", { owner, executionId, holdMs: 1_000 });
  await assert.rejects(runs.dispatch("shell_code_poll", { owner: "other", executionId }), /Unknown code execution/);
  await assert.rejects(runs.dispatch("shell_code_cancel", { owner: "other", executionId }), /Unknown code execution/);
  assert.equal((await runs.dispatch("shell_code_cancel", { owner, executionId })).status, "cancelled");
  assert.equal((await held).status, "cancelled");
  assert.equal(readAborted, true);
});

test("nested file reads go through normal policy and audit, and results require a successful audit write", async (t) => {
  const base = mkdtempSync(path.join(tmpdir(), "grokcode-code-mode-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "project");
  mkdirSync(root);
  const inside = path.join(root, "notes.txt");
  const outside = path.join(base, "outside.txt");
  const auditPath = path.join(base, "audit.log");
  writeFileSync(inside, "test fixture");
  writeFileSync(outside, "outside fixture");
  const platform = process.platform === "win32" ? "win32" : "posix";
  const policy = parsePolicy(JSON.stringify({ version: 1, roots: [root], allow: [] }), platform, base);
  const runtime = createShellRuntime({ platform, home: base, enableCodeMode: true, auditPath, loadPolicy: () => ({ policy, source: "test" }) });
  const code = `
    const allowed = await tools.read_file({path: ${JSON.stringify(inside)}});
    try { await tools.read_file({path: ${JSON.stringify(outside)}}); }
    catch (err) { return [allowed.content, err.message]; }
  `;
  const start = (script: string) => runtime.execute("shell_code_execute", { owner: "owner", code: script }) as Promise<{ status: string; result?: unknown }>;
  assert.deepEqual((await start(code)).result, ["test fixture", "path_denied"]);
  const events = readFileSync(auditPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(events.filter((event) => event.tool === "shell_read_file").map((event) => event.decision), ["allow", "deny"]);
  rmSync(auditPath);
  mkdirSync(auditPath);
  const unavailable = await start(`
    try { return await tools.read_file({path: ${JSON.stringify(inside)}}); }
    catch (err) { return err.message; }
  `);
  assert.equal(unavailable.result, "audit_unavailable");
});

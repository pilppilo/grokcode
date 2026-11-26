import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { toolErrorPayload, toolResultText } from "grokcode-shared";
import { createShellRuntime, parsePolicy, type AuditEvent } from "grokcode-shell";

test("shell audit records response metrics for running jobs, completed jobs and errors", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "grokcode-audit-"));
  const root = path.join(directory, "workspace");
  mkdirSync(root);
  const auditPath = path.join(directory, "shell-audit.log");
  const platform = process.platform === "win32" ? "win32" : "posix";
  const policy = parsePolicy(JSON.stringify({
    version: 1, roots: [root], allow: [{ command: "echo" }],
    limits: { maxOutputBytes: 4096 },
  }), platform, directory);
  const stdout = new PassThrough();
  let finish = () => {};
  const runtime = createShellRuntime({
    platform, home: directory, auditPath, loadPolicy: () => ({ policy, source: "test" }),
    spawnImpl: () => ({
      stdout, stderr: null,
      kill: () => finish(),
      onExit: (callback) => { finish = () => callback(7, null); },
    }),
  });
  try {
    const sessionScope = "a".repeat(43);
    const started = await runtime.execute("shell_run", { cwd: root, argv: ["echo"], sessionScope }) as { jobId: string };
    const held = runtime.execute("shell_job", { jobId: started.jobId, holdMs: 1000, sessionScope });
    await new Promise((resolve) => setTimeout(resolve, 30));
    stdout.write("é".repeat(3000));
    const finished = await held;
    let denied: unknown;
    await assert.rejects(runtime.execute("shell_job", { jobId: started.jobId }), (error) => {
      denied = error;
      return true;
    });
    const events: AuditEvent[] = readFileSync(auditPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(events.length, 3);
    const payloads = [started, finished, toolErrorPayload(denied)];
    for (const [i, row] of events.entries()) {
      assert.equal(row.bytesReturned, Buffer.byteLength(toolResultText(payloads[i])));
      assert.equal(row.estimatedTokens, Math.ceil(row.bytesReturned / 4));
      assert.ok(row.durationMs >= 0);
    }
    assert.ok(events[1]!.durationMs >= 20);
    assert.deepEqual(events.map((row) => [row.decision, row.exitCode, row.truncated, row.sessionId]), [
      ["allow", null, false, sessionScope],
      ["allow", 7, true, sessionScope],
      ["deny", null, false, null],
    ]);
  } finally {
    runtime.killAll();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("audit CLI summarizes the active and rotated logs", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "grokcode audit "));
  const log = path.join(directory, "shell-audit.log");
  try {
    writeFileSync(`${log}.1`, '{"tool":"shell_run","decision":"allow","ts":"2026-11-25T10:00:00Z"}\r\n');
    writeFileSync(log, [
      { tool: "shell_run", decision: "deny", bytesReturned: 80, ts: "2026-11-25T10:30:00Z" },
      { tool: "shell_send_input", decision: "allow", phase: "admission", bytesReturned: 0, ts: "2026-11-25T11:00:00Z" },
      { tool: "shell_send_input", decision: "allow", bytesReturned: 40, ts: "2026-11-25T11:00:01Z" },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n{");
    const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const response = execFileSync(process.execPath, ["--import", "tsx", cli, "audit", "--file", log], { encoding: "utf8" });
    assert.deepEqual(JSON.parse(response), {
      tools: [
        { tool: "shell_run", calls: 2, denials: 1, bytesReturned: 80 },
        { tool: "shell_send_input", calls: 1, denials: 0, bytesReturned: 40 },
      ],
      busiestHoursUtc: [{ hour: 10, calls: 2 }, { hour: 11, calls: 1 }],
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

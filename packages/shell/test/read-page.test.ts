import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { createShellRuntime } from "../src/execute.js";
import { readFilePage } from "../src/files.js";
import { parsePolicy } from "../src/policy.js";
import { handleStdioMessage, localBackend } from "../src/stdio.js";

function fixture(t: TestContext, content: string) {
  const root = mkdtempSync(path.join(tmpdir(), "grok-read-page-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const platform = process.platform === "win32" ? "win32" : "posix";
  const policy = parsePolicy(JSON.stringify({ version: 1, roots: [root], allow: [] }), platform, root);
  const runtime = createShellRuntime({ platform, home: root, loadPolicy: () => ({ policy, source: "test" }) });
  const file = path.join(root, "notes.txt");
  writeFileSync(file, content);
  const read = (args: Record<string, unknown> = {}) =>
    runtime.execute("shell_read_file", { path: file, ...args }) as ReturnType<typeof readFilePage>;
  return { read, runtime, file };
}

test("read_file pages at 800 lines and continues an inclusive line range", async (t) => {
  const lines = Array.from({ length: 1_700 }, (_, i) => `line ${i + 1} 🙂\r\n`);
  const content = lines.join("");
  const { read } = fixture(t, content);
  const range = { startLine: 12, endLine: 1_620 };
  const first = await read(range);
  assert.equal(first.startLine, 12);
  assert.equal(first.endLine, 811);
  assert.equal(first.totalLines, 1_700);
  assert.equal(first.totalBytes, Buffer.byteLength(content));
  assert.equal(first.hasMore, true);
  assert.equal(first.fileComplete, false);
  const second = await read({ ...range, offset: first.nextOffset });
  assert.equal(second.startLine, 812);
  assert.equal(second.endLine, 1_611);
  assert.equal(second.hasMore, true);
  const last = await read({ ...range, offset: second.nextOffset });
  assert.equal(last.endLine, 1_620);
  assert.equal(last.hasMore, false);
  assert.equal(last.fileComplete, false);
  assert.match(last.coverage, /Continue with startLine=1621/);
  assert.equal(first.content + second.content + last.content, lines.slice(11, 1_620).join(""));
});

test("MCP read_file puts file-level coverage around the unescaped content of a partial range", async (t) => {
  const { runtime, file } = fixture(t, "first\r\nsecond\r\nthird\r\nfourth\r\n");
  const response = await handleStdioMessage({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "read_file", arguments: { path: file, startLine: 2, endLine: 3 } },
  }, localBackend("fixture", runtime)) as { result: { isError: boolean; content: Array<{ text: string }> } };
  const body = response.result.content[0]!.text;
  assert.equal(response.result.isError, false, body);
  const [summary, metadata] = body.split("\n");
  assert.match(summary!, /^Showing lines 2-3 of 4\. This response leaves 2 lines/);
  assert.match(summary!, /Continue with startLine=4/);
  assert.match(summary!, /For earlier content, use startLine=1/);
  assert.equal(JSON.parse(metadata!).fileComplete, false);
  assert.equal(JSON.parse(metadata!).hasMore, false);
  assert.ok(body.endsWith(`\n\nsecond\r\nthird\r\n\n\n${summary}`));
});

test("read_file continues across byte-limited pages without splitting UTF-8", async (t) => {
  const content = "x".repeat(37_999) + "🙂".repeat(18_000) + "\nfinal";
  const { read, file } = fixture(t, content);
  const first = await read({ maxBytes: 100_000 });
  assert.equal(first.nextOffset, 37_999);
  assert.equal(first.endLine, 1);
  assert.match(first.coverage, /leaves 2 lines.*Continue with offset=37999/);
  await assert.rejects(read({ offset: first.nextOffset + 1 }), /UTF-8 character boundary/);
  await assert.rejects(read({ offset: first.nextOffset, maxBytes: 3 }), /too small/);
  const second = await read({ offset: first.nextOffset });
  const last = await read({ offset: second.nextOffset });
  assert.equal(second.startLine, 1);
  assert.equal(second.bytes, 38_000);
  assert.equal(last.hasMore, false);
  assert.equal(last.fileComplete, false);
  assert.match(last.coverage, /leaves 1 line unread or partially read.*startLine=1/);
  assert.equal(last.endLine, 2);
  assert.equal(last.totalLines, 2);
  assert.equal(last.nextOffset, Buffer.byteLength(content));
  assert.equal(first.content + second.content + last.content, content);
  const empty = await read({ startLine: 3 });
  assert.equal(empty.content, "");
  assert.equal(empty.startLine, null);
  assert.equal(empty.hasMore, false);
  assert.equal(empty.fileComplete, false);
  assert.match(empty.coverage, /No lines shown of 2.*startLine=1/);
  await assert.rejects(read({ startLine: 2, offset: 0 }), /outside the requested line range/);
  await assert.rejects(read({ path: path.join(path.dirname(path.dirname(file)), "outside.txt") }), /outside the allowed roots/);
});

test("read_file reports whole-file coverage for complete and empty files", async (t) => {
  for (const content of ["", "one\ntwo"]) {
    const { read } = fixture(t, content);
    const result = await read();
    assert.equal(result.fileComplete, true);
    assert.match(result.coverage, /covers the whole file/);
  }
});

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { createShellRuntime } from "../src/execute.js";
import type { listDir } from "../src/files.js";
import { parsePolicy } from "../src/policy.js";
import { handleStdioMessage, localBackend } from "../src/stdio.js";

function fixture(t: TestContext) {
  const temp = realpathSync.native(mkdtempSync(path.join(tmpdir(), "grokcode-list-dir-")));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, "root");
  mkdirSync(root);
  const platform = process.platform === "win32" ? "win32" : "posix";
  const policy = parsePolicy(JSON.stringify({ version: 1, roots: [root], allow: [] }), platform, root);
  const runtime = createShellRuntime({ platform, home: root, loadPolicy: () => ({ policy, source: "test" }) });
  const list = async () => {
    const response = await handleStdioMessage({
      jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_dir", arguments: { path: root } },
    }, localBackend("fixture", runtime)) as { result: { content: { text: string }[]; isError: boolean } };
    const raw = response.result.content[0]!.text;
    assert.equal(response.result.isError, false, raw);
    return JSON.parse(raw) as Awaited<ReturnType<typeof listDir>>;
  };
  return { root, temp, list };
}

test("list_dir shows byte sizes, exact line counts, and marked estimates", async (t) => {
  const { root, list } = fixture(t);
  const source = "first\r\n🙂\nlast";
  writeFileSync(path.join(root, "source.ts"), source);
  writeFileSync(path.join(root, "empty.txt"), "");
  writeFileSync(path.join(root, "large.txt"), "x\n".repeat(45_000));
  writeFileSync(path.join(root, "binary.bin"), Buffer.from([0, 10, 26]));
  const result = await list();
  assert.equal(result.truncated, false);
  assert.deepEqual(result.entries, [
    { name: "binary.bin", type: "file", size: 3, lineCount: null, lineCountEstimated: false },
    { name: "empty.txt", type: "file", size: 0, lineCount: 0, lineCountEstimated: false },
    { name: "large.txt", type: "file", size: 90_000, lineCount: 45_000, lineCountEstimated: true },
    { name: "source.ts", type: "file", size: Buffer.byteLength(source), lineCount: 3, lineCountEstimated: false },
  ]);
});

test("list_dir keeps directory and symlink entries and withholds metadata for denied files", async (t) => {
  const { root, temp, list } = fixture(t);
  const outside = path.join(temp, "outside");
  mkdirSync(outside);
  mkdirSync(path.join(root, "folder"));
  symlinkSync(outside, path.join(root, "link"), process.platform === "win32" ? "junction" : "dir");
  writeFileSync(path.join(root, ".env"), "fixture value\n");
  const result = await list();
  assert.deepEqual(result.entries, [
    { name: ".env", type: "file", size: null, lineCount: null, lineCountEstimated: false },
    { name: "folder", type: "dir" },
    { name: "link", type: "symlink" },
  ]);
});

test("list_dir keeps the 500-entry sorted cap", async (t) => {
  const { root, list } = fixture(t);
  for (let index = 500; index >= 0; index--) {
    writeFileSync(path.join(root, `${String(index).padStart(3, "0")}.txt`), "");
  }
  const result = await list();
  assert.equal(result.truncated, true);
  assert.equal(result.entries.length, 500);
  assert.equal(result.entries[0]?.name, "000.txt");
  assert.equal(result.entries.at(-1)?.name, "499.txt");
});

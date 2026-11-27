import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { createShellRuntime } from "../src/execute.js";
import { parsePolicy } from "../src/policy.js";
import { handleStdioMessage, localBackend } from "../src/stdio.js";

function fixture(t: TestContext) {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "grokcode-read-files-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  mkdirSync(project);
  const platform = process.platform === "win32" ? "win32" : "posix";
  const policy = parsePolicy(JSON.stringify({ version: 1, roots: [root], allow: [], projects: { app: { root: project } } }), platform, root);
  const runtime = createShellRuntime({ platform, home: root, loadPolicy: () => ({ policy, source: "test" }) });
  const tool = async (name: string, args: Record<string, unknown>) => {
    const response = await handleStdioMessage({
      jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args },
    }, localBackend("fixture", runtime)) as { result: { content: { text: string }[]; isError: boolean } };
    return { text: response.result.content[0]!.text, isError: response.result.isError };
  };
  return { project, root, tool };
}

test("read_files returns several complete files in request order with raw redacted content", async (t) => {
  const { project, tool } = fixture(t);
  writeFileSync(path.join(project, "a.txt"), "first\r\napi_key=test-fixture-value\n");
  writeFileSync(path.join(project, "b.txt"), "second\n");
  const result = await tool("read_files", { project: "app", paths: ["b.txt", "a.txt"] });
  assert.equal(result.isError, false, result.text);
  assert.match(result.text, /\[1\] "b\.txt" Complete/);
  assert.match(result.text, /\[2\] "a\.txt" Complete/);
  assert.ok(result.text.endsWith("[1]\nsecond\n\n\n[2]\nfirst\r\napi_key=[REDACTED]\n"));
});

test("read_files respects the total reply cap and reports continuations and unread paths", async (t) => {
  const { project, tool } = fixture(t);
  const source = "🙂".repeat(11_000);
  const paths = ["first.txt", "second.txt", "third.txt"].map((name) => path.join(project, name));
  for (const file of paths) writeFileSync(file, source);
  const result = await tool("read_files", { paths });
  assert.equal(result.isError, false, result.text);
  assert.ok(Buffer.byteLength(result.text, "utf8") <= 46_000);
  assert.match(result.text, /first\.txt" Partial\..*offset=38000/);
  assert.match(result.text, /second\.txt" Partial\..*offset=\d+/);
  assert.match(result.text, /third\.txt" Unread/);
  const continued = await tool("read_file", { path: paths[0], offset: 38_000 });
  assert.equal(continued.isError, false, continued.text);
  assert.ok(continued.text.includes(source.slice(19_000)));
});

test("read_files validates the whole batch and enforces the project root", async (t) => {
  const { project, root, tool } = fixture(t);
  writeFileSync(path.join(project, "ok.txt"), "allowed fixture");
  writeFileSync(path.join(root, "outside.txt"), "outside fixture");
  const denied = await tool("read_files", { project: "app", paths: ["ok.txt", "../outside.txt"] });
  assert.equal(denied.isError, true);
  assert.match(denied.text, /outside the allowed roots/);
  assert.doesNotMatch(denied.text, /allowed fixture/);
  const invalid = await tool("read_files", { project: "app", paths: Array(9).fill("ok.txt") });
  assert.equal(invalid.isError, true);
  assert.match(invalid.text, /1 to 8 file paths/);
});

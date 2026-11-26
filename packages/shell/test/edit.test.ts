import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { createShellRuntime } from "../src/execute.js";
import { parsePolicy } from "../src/policy.js";
import { handleStdioMessage, localBackend } from "../src/stdio.js";
import { SHELL_TOOLS } from "../src/tools.js";

function fixture(t: TestContext, text: string) {
  const parent = mkdtempSync(path.join(tmpdir(), "grokcode-edit-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = path.join(parent, "project");
  mkdirSync(root);
  const file = path.join(root, "notes.txt");
  const auditPath = path.join(parent, "audit.log");
  const platform = process.platform === "win32" ? "win32" : "posix";
  const policy = parsePolicy(JSON.stringify({ version: 1, roots: [root], projects: { app: { root } }, allow: [] }), platform, parent);
  const runtime = createShellRuntime({ platform, home: parent, auditPath, loadPolicy: () => ({ policy, source: "test" }) });
  writeFileSync(file, text);
  const edit = (oldText: string, newText: string, args: Record<string, unknown> = {}) =>
    runtime.execute("shell_edit_file", { path: file, oldText, newText, ...args });
  return { file, edit, runtime, root, auditPath };
}

test("edit_file is a confirmed write and preserves CRLF and file mode", async (t) => {
  const { runtime, file, auditPath } = fixture(t, "keep\r\nalpha\r\nbeta\r\nkeep\r\n");
  chmodSync(file, 0o640);
  const mode = statSync(file).mode;
  const tool = SHELL_TOOLS.find(({ name }) => name === "edit_file");
  assert.equal(tool?.annotations.destructiveHint, true);
  assert.equal(tool?.annotations.readOnlyHint, false);
  const response = await handleStdioMessage({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "edit_file", arguments: { project: "app", path: "notes.txt", oldText: "alpha\nbeta", newText: "one\r\ntwo\nthree" } },
  }, localBackend("test", runtime)) as { result: { isError: boolean; content: Array<{ text: string }> } };
  assert.equal(response.result.isError, false, response.result.content[0]?.text);
  const result = JSON.parse(response.result.content[0]!.text);
  assert.deepEqual(result.diff, { added: 3, removed: 2, exact: true, summary: "+3/-2 lines" });
  assert.equal(result.replacements, 1);
  assert.equal(readFileSync(file, "utf8"), "keep\r\none\r\ntwo\r\nthree\r\nkeep\r\n");
  assert.equal(statSync(file).mode, mode);
  const audit = JSON.parse(readFileSync(auditPath, "utf8").trim());
  assert.equal(audit.tool, "shell_edit_file");
  assert.equal(audit.decision, "allow");
  assert.equal("oldText" in audit, false);
  assert.equal("newText" in audit, false);
});

test("edit_file rejects missing and ambiguous matches and preserves untouched mixed endings", async (t) => {
  const original = "start\r\nalpha\nlast\r\nalpha\nlast";
  const { edit, file, root } = fixture(t, original);
  await assert.rejects(edit("missing", "new"), { code: "edit_no_match" });
  await assert.rejects(edit("alpha\r\nlast", "new"), { code: "edit_multiple_matches" });
  assert.equal(readFileSync(file, "utf8"), original);
  await edit("alpha\r\nlast", "changed\r\nnow", { replaceAll: true });
  assert.equal(readFileSync(file, "utf8"), "start\r\nchanged\nnow\r\nchanged\nnow");
  const protectedFile = path.join(root, ".env");
  writeFileSync(protectedFile, "fixture");
  await assert.rejects(edit("fixture", "changed", { path: protectedFile }), { code: "path_denied" });
  assert.equal(readFileSync(protectedFile, "utf8"), "fixture");
});

test("concurrent edits serialize read-modify-write and a failed edit releases the lock", async (t) => {
  const { edit, file } = fixture(t, "alpha\nother\n");
  const result = await Promise.allSettled([
    edit("alpha", "beta"),
    edit("missing", "ignored"),
    edit("beta", "gamma"),
    edit("other\n", ""),
  ]);
  assert.deepEqual(result.map(({ status }) => status), ["fulfilled", "rejected", "fulfilled", "fulfilled"]);
  assert.equal(readFileSync(file, "utf8"), "gamma\n");
});

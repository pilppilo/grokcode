import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { createShellRuntime } from "../src/execute.js";
import { parsePolicy } from "../src/policy.js";
import type { searchFiles } from "../src/search.js";
import { handleStdioMessage, localBackend } from "../src/stdio.js";

function fixture(t: TestContext) {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "grokcode-search-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "app");
  mkdirSync(project);
  const platform = process.platform === "win32" ? "win32" : "posix";
  const policy = parsePolicy(JSON.stringify({
    version: 1, roots: [root], projects: { app: { root: project } }, allow: [{ command: "rg" }],
  }), platform, root);
  const runtime = createShellRuntime({ platform, home: root, loadPolicy: () => ({ policy, source: "test" }) });
  const search = (args: Record<string, unknown> = {}) =>
    runtime.execute("shell_search_files", { query: "needle", project: "app", ...args }) as ReturnType<typeof searchFiles>;
  return { search, runtime, project, root };
}

test("search_files advertises a project-only search and reports default exclusions on zero matches", async (t) => {
  const { runtime, project, root } = fixture(t);
  const backend = localBackend("fixture", runtime);
  const listed = await handleStdioMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" }, backend) as {
    result: { tools: { name: string; description: string; inputSchema: { required: string[] } }[] };
  };
  const definition = listed.result.tools.find((tool) => tool.name === "search_files");
  assert.deepEqual(definition?.inputSchema.required, ["query"]);
  assert.match(definition?.description ?? "", /node_modules, dist, build, target, __pycache__/);
  mkdirSync(path.join(project, "node_modules"));
  writeFileSync(path.join(project, "node_modules", "dependency.ts"), "needle");
  writeFileSync(path.join(project, "entry.js.map"), "needle");
  writeFileSync(path.join(root, "outside.ts"), "needle");

  const response = await handleStdioMessage({
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "search_files", arguments: { query: "needle", project: "app" } },
  }, backend) as { result: { content: { text: string }[]; isError: boolean } };
  const raw = response.result.content[0]!.text;
  assert.equal(response.result.isError, false, raw);
  const result = JSON.parse(raw) as Awaited<ReturnType<typeof searchFiles>>;
  assert.equal(result.cwd, project);
  assert.deepEqual(result.skipped.directories, ["node_modules", "dist", "build", "target", "__pycache__"]);
  assert.deepEqual(result.skipped.filePatterns, ["*.map"]);
  assert.deepEqual(result.matches, []);
  assert.equal(result.scanLimit, null);
  assert.equal(result.truncated, false);
});

test("search_files opts into ignored directories and source maps independently", async (t) => {
  const { search, project, root } = fixture(t);
  mkdirSync(path.join(project, "dist"));
  writeFileSync(path.join(project, "dist", "built.js"), "needle");
  writeFileSync(path.join(project, "dist", "built.js.map"), "needle");
  writeFileSync(path.join(project, "dist", "credentials.json"), "needle");
  writeFileSync(path.join(project, "bundle.js.map"), "needle");
  writeFileSync(path.join(project, ".hidden"), "needle");
  const ignored = await search({ includeIgnored: true, glob: "*.*" });
  assert.deepEqual(ignored.skipped.directories, []);
  assert.deepEqual(ignored.matches.map((match) => match.path), [path.join(project, "dist", "built.js")]);
  const maps = await search({ glob: "*.map" });
  assert.deepEqual(maps.skipped.filePatterns, []);
  assert.equal(maps.glob, "*.map");
  assert.deepEqual(maps.matches.map((match) => match.path), [path.join(project, "bundle.js.map")]);
  await assert.rejects(search({ cwd: root, includeIgnored: true }), /outside the allowed roots/);
  await assert.rejects(search({ project: undefined }), /cwd/);
  await assert.rejects(search({ includeIgnored: "true" }), /includeIgnored must be a boolean/);
});

test("search_files reports the requested alias in scope and match paths", async (t) => {
  const { search, project } = fixture(t);
  const dependency = path.join(project, "node_modules", ".pnpm", "dependency", "node_modules", "dependency");
  mkdirSync(path.join(dependency, "src"), { recursive: true });
  writeFileSync(path.join(dependency, "src", "index.ts"), "needle\n");
  const requested = path.join("node_modules", "dependency");
  const alias = path.join(project, requested);
  symlinkSync(dependency, alias, process.platform === "win32" ? "junction" : "dir");

  const result = await search({ cwd: requested });
  assert.equal(result.cwd, alias);
  assert.deepEqual(result.matches, [{ path: path.join(alias, "src", "index.ts"), line: 1, text: "needle" }]);
  const broad = await search({ includeIgnored: true });
  assert.deepEqual(broad.matches, []);
});

test("search_files distinguishes capped matches from partially scanned files", async (t) => {
  const { search, project } = fixture(t);
  writeFileSync(path.join(project, "many.txt"), "needle\n".repeat(101));
  writeFileSync(path.join(project, "large.txt"), "needle\n" + "x".repeat(200_000) + "\nneedle");
  const capped = await search({ glob: "many.txt" });
  assert.equal(capped.matches.length, 100);
  assert.equal(capped.resultsCapped, true);
  assert.equal(capped.filesPartiallyScanned, false);
  assert.equal(capped.scanLimit, null);
  assert.equal(capped.truncated, true);
  const partial = await search({ glob: "large.txt" });
  assert.equal(partial.matches.length, 1);
  assert.equal(partial.resultsCapped, false);
  assert.equal(partial.filesPartiallyScanned, true);
  assert.equal(partial.scanLimit, null);
  assert.equal(partial.truncated, true);
});

test("search_files reports when the byte budget leaves files unvisited", async (t) => {
  const { search, project } = fixture(t);
  const content = "x".repeat(200_000);
  for (let index = 0; index < 41; index++) {
    writeFileSync(path.join(project, `file-${index}.txt`), content);
  }
  const result = await search();
  assert.deepEqual(result.matches, []);
  assert.equal(result.resultsCapped, false);
  assert.equal(result.filesPartiallyScanned, false);
  assert.equal(result.scanLimit, "bytes");
  assert.equal(result.truncated, true);
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ToolError } from "grokcode-shared";

import { createShellRuntime, parsePolicy } from "../src/index.ts";
import type { Policy } from "../src/policy.ts";

function runtimeFor(root: string, policy: Policy, auditPath?: string) {
  return createShellRuntime({
    platform: "posix",
    home: root,
    loadPolicy: () => ({ policy, source: "test" }),
    ...(auditPath ? { auditPath } : {}),
  });
}

function basePolicy(root: string, allow: Policy["allow"], git?: Policy["git"]): Policy {
  return parsePolicy(
    JSON.stringify({
      version: 1,
      roots: [root],
      allowShell: false,
      allowInterpreters: false,
      allow,
      ...(git ? { git } : {}),
    }),
    "posix",
    root,
  );
}

test("run_command admit-then-poll runs echo and redacts secrets", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "grokcode-shell-"));
  const auditPath = path.join(root, "audit.log");
  try {
    const runtime = runtimeFor(root, basePolicy(root, [{ command: "echo" }]), auditPath);
    const started = (await runtime.execute("shell_run", {
      argv: ["echo", "hello ghp_abcdefghijklmnopqrstuvwxyz123456"],
      cwd: root,
    })) as { jobId: string; status: string };
    assert.match(started.jobId, /^job_/);
    let view = (await runtime.execute("shell_job", { jobId: started.jobId })) as {
      status: string;
      output: string;
      exitCode: number | null;
    };
    for (let i = 0; i < 50 && view.status === "running"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      view = (await runtime.execute("shell_job", { jobId: started.jobId })) as typeof view;
    }
    assert.equal(view.status, "exited");
    assert.equal(view.exitCode, 0);
    assert.match(view.output, /hello/);
    assert.equal(view.output.includes("ghp_"), false);
    assert.match(view.output, /REDACTED-GITHUB/);
    const polled = (await runtime.execute("shell_job", { jobId: started.jobId, view: "poll", offset: 0 })) as {
      output: string;
      done: boolean;
    };
    assert.equal(polled.done, true);
    assert.match(polled.output, /hello/);
    const audit = readFileSync(auditPath, "utf8");
    assert.match(audit, /"decision":"allow"/);
    assert.equal(audit.includes("ghp_"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing policy denies commands and file writes", async () => {
  const runtime = createShellRuntime({
    platform: "posix",
    home: "/tmp",
    loadPolicy: () => ({ policy: null, source: "(unset)", error: "no policy" }),
  });
  const info = (await runtime.execute("shell_info", {})) as { policyLoaded: boolean; shell: string };
  assert.equal(info.policyLoaded, false);
  assert.equal(info.shell, "bash");
  await assert.rejects(() => runtime.execute("shell_run", { argv: ["echo", "x"], cwd: "/tmp" }), /no policy/);
});

test("files stay inside the roots and refuse symlink escapes", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "grokcode-root-"));
  const outside = mkdtempSync(path.join(tmpdir(), "grokcode-out-"));
  try {
    const runtime = runtimeFor(root, basePolicy(root, []));
    const file = path.join(root, "note.txt");
    const written = (await runtime.execute("shell_write_file", { path: file, contents: "alpha\n" })) as { bytes: number };
    assert.equal(written.bytes, 6);
    const read = (await runtime.execute("shell_read_file", { path: file })) as { content: string };
    assert.equal(read.content, "alpha\n");
    const listed = (await runtime.execute("shell_list_dir", { path: root })) as { entries: Array<{ name: string }> };
    assert.ok(listed.entries.some((entry) => entry.name === "note.txt"));
    await assert.rejects(
      () => runtime.execute("shell_read_file", { path: path.join(root, "..", path.basename(outside), "nope") }),
      (err: unknown) => err instanceof ToolError && err.code === "path_denied",
    );
    await assert.rejects(() => runtime.execute("shell_write_file", { path: path.join(root, ".env"), contents: "TOKEN=abcdefghi" }), ToolError);
    symlinkSync(outside, path.join(root, "escape"));
    await assert.rejects(() => runtime.execute("shell_read_file", { path: path.join(root, "escape") }), ToolError);
    writeFileSync(path.join(root, "inside.txt"), "inside\n");
    symlinkSync(path.join(root, "inside.txt"), path.join(root, "ok-link"));
    const viaLink = (await runtime.execute("shell_read_file", { path: path.join(root, "ok-link") })) as { content: string };
    assert.equal(viaLink.content, "inside\n");
    const patched = (await runtime.execute("shell_apply_patch", {
      cwd: root,
      patch: "--- a/note.txt\n+++ b/note.txt\n@@ -1 +1 @@\n-alpha\n+beta\n",
    })) as { files: Array<{ action: string }> };
    assert.equal(patched.files[0]?.action, "updated");
    assert.equal(readFileSync(file, "utf8"), "beta\n");
    await assert.rejects(
      () =>
        runtime.execute("shell_apply_patch", {
          cwd: root,
          patch: "--- a/../../etc/passwd\n+++ b/../../etc/passwd\n@@ -1 +1 @@\n-x\n+y\n",
        }),
      ToolError,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("git_commit_push respects the branch allowlist", async () => {
  let git = true;
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
  } catch {
    git = false;
  }
  if (!git) return;
  const root = mkdtempSync(path.join(tmpdir(), "grokcode-git-"));
  try {
    execFileSync("git", ["init", "-b", "cursor/test"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "ada@example.com"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Ada"], { cwd: root, stdio: "ignore" });
    writeFileSync(path.join(root, "note.txt"), "one\n");
    const runtime = runtimeFor(
      root,
      basePolicy(root, [], { branches: ["cursor/*"], push: false }),
    );
    const status = (await runtime.execute("shell_git_status", { cwd: root })) as { output: string };
    assert.match(status.output, /note\.txt/);
    const committed = (await runtime.execute("shell_git_commit", {
      cwd: root,
      message: "add note",
      paths: ["note.txt"],
      push: false,
    })) as { branch: string };
    assert.equal(committed.branch, "cursor/test");
    execFileSync("git", ["checkout", "-b", "dev"], { cwd: root, stdio: "ignore" });
    writeFileSync(path.join(root, "other.txt"), "two\n");
    await assert.rejects(
      () => runtime.execute("shell_git_commit", { cwd: root, message: "nope", paths: ["other.txt"] }),
      /allowlist/,
    );
    await assert.rejects(
      () =>
        runtime.execute("shell_git_commit", {
          cwd: root,
          message: "nope",
          paths: ["note.txt"],
          push: true,
        }),
      /push|allowlist/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

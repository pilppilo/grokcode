import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
    const linesPath = path.join(root, "lines.txt");
    writeFileSync(linesPath, "one\ntwo\nthree\n");
    const range = await runtime.execute("shell_read_file", { path: linesPath, startLine: 2, endLine: 2 }) as {
      content: string; nextOffset: number; truncated: boolean;
    };
    assert.equal(range.content, "two\n");
    assert.equal(range.nextOffset, 8);
    assert.equal(range.truncated, false);
    writeFileSync(linesPath, "one\n\nthree\n");
    await runtime.execute("shell_apply_patch", {
      cwd: root,
      patch: ["--- a/lines.txt", "+++ b/lines.txt", "@@ -1,3 +1,3 @@", " one", "", "-three", "+four", ""].join("\n"),
    });
    assert.equal(readFileSync(linesPath, "utf8"), "one\n\nfour\n");
    await runtime.execute("shell_apply_patch", {
      cwd: root,
      patch: [
        "--- a/lines.txt", "+++ b/lines.txt", "@@ -3 +3 @@", "-four", "+five", "",
        "--- a/note.txt", "+++ b/note.txt", "@@ -1 +1 @@", "-alpha", "+updated", "",
      ].join("\n"),
    });
    assert.equal(readFileSync(linesPath, "utf8"), "one\n\nfive\n");
    assert.equal(readFileSync(file, "utf8"), "updated\n");
    writeFileSync(file, "alpha\n");
    const listed = (await runtime.execute("shell_list_dir", { path: root })) as { entries: Array<{ name: string }> };
    assert.ok(listed.entries.some((entry) => entry.name === "note.txt"));
    await assert.rejects(
      () => runtime.execute("shell_read_file", { path: path.join(root, "..", path.basename(outside), "nope") }),
      (err: unknown) => err instanceof ToolError && err.code === "path_denied",
    );
    await assert.rejects(() => runtime.execute("shell_write_file", { path: path.join(root, ".env"), contents: "TOKEN=abcdefghi" }), ToolError);
    await assert.rejects(
      () => runtime.execute("shell_write_file", { path: path.join(root, "nested", ".git"), contents: "gitdir: /tmp/evil\n" }),
      (err: unknown) => err instanceof ToolError && err.code === "path_denied",
    );
    const ignore = path.join(root, ".gitignore");
    await runtime.execute("shell_write_file", { path: ignore, contents: "node_modules\n" });
    const ignoreRead = (await runtime.execute("shell_read_file", { path: ignore })) as { content: string };
    assert.equal(ignoreRead.content, "node_modules\n");
    const workflow = path.join(root, ".github", "workflows", "ci.yml");
    await runtime.execute("shell_write_file", { path: workflow, contents: "name: ci\n" });
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
    await assert.rejects(() => runtime.execute("shell_apply_patch", {
      cwd: root,
      patch: [
        "--- a/note.txt", "+++ b/note.txt", "@@ -1 +1 @@", "-beta", "+gamma",
        "", "--- a/inside.txt", "+++ b/inside.txt", "@@ -1 +1 @@", "-wrong", "+next", "",
      ].join("\n"),
    }), ToolError);
    assert.equal(readFileSync(file, "utf8"), "beta\n");
    const code = path.join(root, "source.ts");
    writeFileSync(code, 'const secret = requestedMethod;\nconst config = { password: options.password };\n');
    const source = await runtime.execute("shell_read_file", { path: code }) as { content: string };
    assert.equal(source.content, readFileSync(code, "utf8"));
    const python = path.join(root, "source.py");
    writeFileSync(python, 'password = options.password\nsecret = "abc"\npassword = ""\nsecret = "example-secret"\n');
    const pythonSource = await runtime.execute("shell_read_file", { path: python }) as { content: string };
    assert.equal(pythonSource.content, 'password = options.password\nsecret = "abc"\npassword = ""\nsecret = "[REDACTED]"\n');
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
      basePolicy(root, [{ command: "git", subcommands: ["status", "diff", "log"] }], { branches: ["cursor/*"], push: false }),
    );
    const marker = path.join(root, "fsmonitor-ran");
    const hookMarker = path.join(root, "hook-ran");
    execFileSync("git", ["config", "core.fsmonitor", `touch ${marker}`], { cwd: root });
    const hooks = path.join(root, "evil-hooks");
    mkdirSync(hooks);
    writeFileSync(path.join(hooks, "pre-commit"), `#!/bin/sh\ntouch ${hookMarker}\n`, { mode: 0o755 });
    execFileSync("git", ["config", "core.hooksPath", hooks], { cwd: root });
    const status = (await runtime.execute("shell_git_status", { cwd: root })) as { output: string };
    assert.equal(existsSync(marker), false);
    assert.match(status.output, /note\.txt/);
    writeFileSync(path.join(root, "staged.txt"), "already staged\n");
    execFileSync("git", ["add", "--", "staged.txt"], { cwd: root });
    const committed = (await runtime.execute("shell_git_commit", {
      cwd: root,
      message: "add note",
      paths: ["note.txt"],
      push: false,
    })) as { branch: string };
    assert.equal(committed.branch, "cursor/test");
    assert.equal(existsSync(hookMarker), false);
    const diff = await runtime.execute("shell_git_diff", { cwd: root, staged: true }) as { output: string };
    assert.match(diff.output, /staged\.txt/);
    writeFileSync(path.join(root, ".gitattributes"), "note.txt filter=untrusted\n");
    execFileSync("git", ["config", "filter.untrusted.clean", "false"], { cwd: root });
    execFileSync("git", ["config", "filter.untrusted.required", "true"], { cwd: root });
    writeFileSync(path.join(root, "note.txt"), "unstaged edit\n");
    const unstaged = await runtime.execute("shell_git_diff", { cwd: root }) as { output: string };
    assert.match(unstaged.output, /unstaged edit/);
    const filtered = await runtime.execute("shell_git_commit", {
      cwd: root,
      message: "with filter",
      paths: ["note.txt"],
      push: false,
    }) as { branch: string };
    assert.equal(filtered.branch, "cursor/test");
    assert.equal(existsSync(hookMarker), false);
    assert.equal(execFileSync("git", ["show", "HEAD:note.txt"], { cwd: root, encoding: "utf8" }), "unstaged edit\n");
    const log = await runtime.execute("shell_git_log", { cwd: root, limit: 1 }) as { output: string };
    assert.match(log.output, /with filter/);
    assert.equal(execFileSync("git", ["show", "--format=", "--name-only", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), "note.txt");
    assert.equal(execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: root, encoding: "utf8" }).trim(), "staged.txt");
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

test("file search skips hidden and sensitive paths and returns line numbers", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "grokcode-search-"));
  try {
    const runtime = runtimeFor(root, basePolicy(root, [{ command: "rg" }]));
    writeFileSync(path.join(root, "note.txt"), `${"a".repeat(33_000)}\nmatch here\n`);
    mkdirSync(path.join(root, "node_modules"));
    writeFileSync(path.join(root, "node_modules", "dep.txt"), "match here\n");
    writeFileSync(path.join(root, ".env"), "match here\n");
    writeFileSync(path.join(root, "hidden.pem"), "match here\n");
    const found = await runtime.execute("shell_search_files", { cwd: root, query: "match", glob: "*.*" }) as {
      matches: { path: string; line: number }[];
    };
    assert.deepEqual(found.matches.map(({ path: file, line }) => [path.basename(file), line]), [["note.txt", 2]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a running job can be cancelled repeatedly", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "grokcode-cancel-"));
  let kills = 0;
  const runtime = createShellRuntime({
    platform: "posix",
    home: root,
    loadPolicy: () => ({ policy: basePolicy(root, [{ command: "echo" }]), source: "(test)" }),
    spawnImpl: () => ({
      stdout: null,
      stderr: null,
      kill: () => { kills++; },
      onExit: () => {},
    }),
  });
  try {
    const job = await runtime.execute("shell_run", {
      cwd: root,
      argv: ["echo", "test"],
    }) as { jobId: string };
    const cancelled = await runtime.execute("shell_kill_job", { jobId: job.jobId }) as { status: string };
    const repeated = await runtime.execute("shell_kill_job", { jobId: job.jobId }) as { status: string };
    assert.equal(cancelled.status, "cancelled");
    assert.equal(repeated.status, "cancelled");
    assert.equal(kills, 1);
  } finally {
    runtime.killAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing programs report spawn errors immediately", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "grokcode-missing-program-"));
  try {
    const program = "grokcode-test-missing-program";
    const runtime = runtimeFor(root, basePolicy(root, [{ command: program }]));
    await assert.rejects(
      () => runtime.execute("shell_run", { cwd: root, argv: [program], timeoutMs: 10_000 }),
      (err: unknown) => err instanceof ToolError && err.code === "not_found",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("named projects scope relative file paths to their own root", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "grokcode-project-"));
  try {
    const projectRoot = path.join(root, "app");
    mkdirSync(projectRoot);
    writeFileSync(path.join(projectRoot, "note.txt"), "inside");
    writeFileSync(path.join(root, "outside.txt"), "outside");
    const policy = parsePolicy(JSON.stringify({
      version: 1,
      roots: [root],
      projects: { app: { root: projectRoot, testCommand: ["npm", "test"] } },
    }), "posix", root);
    const runtime = runtimeFor(root, policy);
    const result = await runtime.execute("shell_read_file", { project: "app", path: "note.txt" });
    assert.match(JSON.stringify(result), /inside/);
    await assert.rejects(
      runtime.execute("shell_read_file", { project: "app", path: "../outside.txt" }),
      /root/i,
    );
    await assert.rejects(
      runtime.execute("shell_read_file", { project: "unknown", path: "note.txt" }),
      /Available projects: app/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("project test runs finish even when output exceeds the retained tail", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "grokcode-project-test-"));
  try {
    const policy = parsePolicy(JSON.stringify({
      version: 1,
      roots: [root],
      allow: [{ command: "cat" }],
      projects: { app: { root, testCommand: ["cat", "output.txt"] } },
    }), "posix", root);
    writeFileSync(path.join(root, "output.txt"), `${"verbose\n".repeat(40_000)}finished\n`);
    const runtime = runtimeFor(root, policy);
    const started = await runtime.execute("shell_run_tests", { project: "app" }) as { jobId: string };
    let result;
    for (let i = 0; i < 50; i++) {
      result = await runtime.execute("shell_job", started) as {
        status: string; exitCode: number | null; truncated: boolean; output: string;
      };
      if (result.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(result?.exitCode, 0);
    assert.equal(result?.truncated, true);
    assert.match(result?.output ?? "", /finished\n$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("check_repo returns the branch, working tree and recent commits", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "grokcode-check-repo-"));
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root });
    git("init", "-q", "-b", "main");
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "initial");
    writeFileSync(path.join(root, "note.txt"), "untracked");
    const policy = parsePolicy(JSON.stringify({
      version: 1,
      roots: [root],
      allow: [{ command: "git", subcommands: ["status", "log"] }],
      projects: { app: { root } },
    }), "posix", root);
    const result = await runtimeFor(root, policy).execute("shell_check_repo", { project: "app" }) as {
      branch: string; status: string; recentCommits: string[];
    };
    assert.equal(result.branch, "main");
    assert.match(result.status, /note.txt/);
    assert.match(result.recentCommits[0] ?? "", /initial$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

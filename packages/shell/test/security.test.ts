import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { ToolError } from "grokcode-shared";

import { HELP, createWriteQueue } from "../src/cli.ts";
import { confine, expandLexical, isSensitivePath } from "../src/confine.ts";
import { createShellRuntime, parsePolicy } from "../src/index.ts";
import { clipUtf8, JobTable } from "../src/jobs.ts";
import { evaluateCommand } from "../src/policy.ts";
import { redact } from "../src/redact.ts";
import { childEnv, resolveTrustedCommand, type SpawnFn } from "../src/spawn.ts";
import type { Policy } from "../src/policy.ts";

function policy(root: string, allow: Policy["allow"], git?: Policy["git"]): Policy {
  return parsePolicy(
    JSON.stringify({ version: 1, roots: [root], allow, ...(git ? { git } : {}) }),
    "posix",
    root,
  );
}

test("a planted path or script shim is not the allowlisted command", () => {
  assert.throws(() => resolveTrustedCommand("./git", { platform: "posix", pathEnv: "/usr/bin", roots: ["/work"] }), /bare name/);
  assert.throws(() => resolveTrustedCommand("git.cmd", { platform: "win32", pathEnv: "C:\\Windows", roots: ["C:\\Work"] }), /script shims/);
  assert.equal(
    resolveTrustedCommand("git", {
      platform: "posix",
      pathEnv: "/work/bin:/usr/bin:.",
      roots: ["/work"],
      exists: (file) => file === "/usr/bin/git" || file === "/work/bin/git",
      realpath: (file) => file,
    }),
    "/usr/bin/git",
  );
  assert.throws(
    () =>
      resolveTrustedCommand("git", {
        platform: "posix",
        pathEnv: "/usr/bin",
        roots: ["/work"],
        exists: (file) => file === "/usr/bin/git",
        realpath: () => "/work/planted/git",
      }),
    /policy root/,
  );
});

test("sensitive paths match .git exactly and reject Windows aliases", () => {
  assert.equal(isSensitivePath("/work/nested/.git", "posix"), true);
  assert.equal(isSensitivePath("/work/nested/.git/config", "posix"), true);
  assert.equal(isSensitivePath("/work/.gitignore", "posix"), false);
  assert.equal(isSensitivePath("/work/.gitattributes", "posix"), false);
  assert.equal(isSensitivePath("/work/.github/workflows/ci.yml", "posix"), false);
  assert.equal(isSensitivePath("C:\\Work\\GIT~1\\config", "win32"), true);
  assert.equal(isSensitivePath("C:\\Work\\.git.\\config", "win32"), true);
  assert.equal(isSensitivePath("C:\\Work\\id_rsa.", "win32"), true);
  assert.equal(isSensitivePath("C:\\Work\\.gitignore", "win32"), false);
  assert.throws(() => expandLexical("C:\\Work\\.git.\\config", "win32", "C:\\Users\\ada"), /short names|trailing/);
  assert.throws(() => expandLexical("C:\\Work\\GIT~1\\config", "win32", "C:\\Users\\ada"), /short names|trailing/);
});

test("canonicalize an existing prefix and re-check it", () => {
  const stat = { isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false } as never;
  assert.throws(
    () =>
      confine("C:\\Work\\alias\\config", {
        platform: "win32",
        home: "C:\\Users\\ada",
        roots: ["C:\\Work"],
        allowMissing: false,
        followFinal: true,
        fs: {
          lstatSync: () => stat,
          realpathSync: (file: string) => (file.toLowerCase().endsWith("\\alias") ? "C:\\Work\\.git" : file),
        },
      }),
    /denied|escapes/,
  );
});

test("child processes get a minimal environment", () => {
  const env = childEnv(
    {
      PATH: "/usr/bin:.:/bin",
      HOME: "/home/ada",
      LANG: "en_US.UTF-8",
      GIT_SSH_COMMAND: "evil",
      GIT_CONFIG_PARAMETERS: "evil",
      LD_PRELOAD: "libevil.so",
      NODE_OPTIONS: "--require /tmp/x",
      RIPGREP_CONFIG_PATH: "/tmp/ripgrep",
      BASH_ENV: "/tmp/bashrc",
    },
    "posix",
  );
  assert.equal(env.PATH, "/usr/bin:/bin");
  assert.equal(env.HOME, "/home/ada");
  assert.equal(env.GIT_SSH_COMMAND, undefined);
  assert.equal(env.GIT_CONFIG_PARAMETERS, undefined);
  assert.equal(env.LD_PRELOAD, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.RIPGREP_CONFIG_PATH, undefined);
  assert.equal(env.BASH_ENV, undefined);
  assert.equal(env.HUSKY, "0");
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
});

test("redaction covers more token shapes and clips on UTF-8 bytes", () => {
  const text = [
    "https://user:secret@example.test/a",
    "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    "ghs_abcdefghijklmnopqrstuvwxyz",
    "ghu_abcdefghijklmnopqrstuvwxyz",
    "sk_live_examplekey",
    "AIzaSyAabcdefghijklmnopqrstuvwxyz",
    "npm_abcdefghijklmnopqrstuvwxyz",
    "glpat-abcdefghijklmnopqrstuvwxyz",
  ].join("\n");
  const clean = redact(text);
  for (const secret of ["user:secret", "wJalr", "ghs_", "ghu_", "sk_live_", "AIzaSyA", "npm_", "glpat-"]) {
    assert.equal(clean.includes(secret), false, secret);
  }
  assert.equal(clipUtf8("ééé", 3), "é");
  assert.equal(Buffer.byteLength(clipUtf8("ééé", 4)), 4);
});

test("job output holds a partial line, redacts argv, and awaits the kill on timeout", async () => {
  let now = 1_000;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stdout = new PassThrough();
  const table = new JobTable(() => now);
  const spec = {
    argv: ["echo", "ghp_abcdefghijklmnopqrstuvwxyz123456"],
    cwd: "/work",
    platform: "posix" as const,
    shell: false,
  };
  const started = table.start(spec, 20, 100_000, () => ({
    stdout,
    stderr: null,
    kill: () => gate,
    onExit() {},
  }));
  stdout.write("ghp_abcdefghij");
  const hidden = table.get(started.jobId);
  assert.equal(hidden.output.includes("ghp_"), false);
  assert.equal(JSON.stringify(hidden.argv).includes("ghp_"), false);
  stdout.write("klmnopqrstuvwxyz123456\n");
  const shown = table.get(started.jobId);
  assert.equal(shown.output.includes("ghp_"), false);
  assert.match(shown.output, /REDACTED-GITHUB/);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(table.get(started.jobId).status, "running");
  now = 2_000;
  release();
  for (let i = 0; i < 40 && table.get(started.jobId).status === "running"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(table.get(started.jobId).status, "timed_out");
});

test("stdio writes do not overlap and help describes NDJSON", async () => {
  const events: string[] = [];
  const queue = createWriteQueue((_chunk, cb) => {
    events.push("start");
    queueMicrotask(() => {
      events.push("end");
      cb();
    });
  });
  await Promise.all([queue(Buffer.from("a")), queue(Buffer.from("b"))]);
  assert.deepEqual(events, ["start", "end", "start", "end"]);
  assert.match(HELP, /newline-delimited JSON/);
  assert.equal(HELP.includes("Content-Length"), false);
});

test("git tools and run_command share the safety wrapper and honor the allowlist", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "grokcode-sec-"));
  const calls: Array<{ argv: string[]; env?: NodeJS.ProcessEnv }> = [];
  const spawnImpl: SpawnFn = (spec) => {
    calls.push({ argv: spec.argv, env: spec.env });
    const stdout = new PassThrough();
    const text = spec.argv.includes("--path-format=absolute")
      ? `${root}\n`
      : spec.argv.includes("symbolic-ref")
      ? "main\n"
      : spec.argv.includes("--get-regexp")
        ? "filter.example.driver.clean\0"
        : "";
    return {
      stdout,
      stderr: null,
      kill() {},
      onExit(cb) {
        setImmediate(() => {
          if (text) stdout.write(text);
          stdout.end();
          cb(0, null);
        });
      },
    };
  };
  const runtime = createShellRuntime({
    platform: "posix",
    home: root,
    loadPolicy: () => ({
      policy: policy(root, [{ command: "git", subcommands: ["status", "add"] }], { branches: ["main"], push: true }),
      source: "test",
    }),
    spawnImpl,
  });
  try {
    await runtime.execute("shell_git_status", { cwd: root });
    const status = calls.find(call => call.argv.includes("status"))?.argv.join(" ") ?? "";
    assert.match(status, /filter\.example\.driver\.process=/);
    assert.match(status, /core\.fsmonitor=/);
    assert.match(status, /core\.hooksPath=\/dev\/null/);
    assert.match(status, /protocol\.ext\.allow=never/);
    assert.match(status, /core\.sshCommand=/);
    assert.match(status, /core\.pager=cat/);
    assert.match(status, /diff\.external=/);
    assert.equal(calls[0]?.env?.HUSKY, "0");
    calls.length = 0;
    await assert.rejects(
      () =>
        createShellRuntime({
          platform: "posix",
          home: root,
          loadPolicy: () => ({ policy: policy(root, [{ command: "git", subcommands: ["diff"] }]), source: "test" }),
          spawnImpl,
        }).execute("shell_git_status", { cwd: root }),
      /allowlist/,
    );
    await assert.rejects(
      () => runtime.execute("shell_run", { cwd: root, argv: ["./git", "status"] }),
      /bare name/,
    );
    await assert.rejects(
      () => runtime.execute("shell_run", { cwd: root, argv: ["git", "push", "ext::sh -c id"] }),
      /remote-helper/,
    );
    await assert.rejects(
      () => runtime.execute("shell_run", { cwd: root, argv: ["git", "push", "origin", "+HEAD:main"] }),
      /force-push|force refspec|\+/,
    );
    calls.length = 0;
    await runtime.execute("shell_run", { cwd: root, argv: ["git", "status"] });
    assert.match(calls.find(call => call.argv.includes("status"))?.argv.join(" ") ?? "", /filter\.example\.driver\.process=/);
    calls.length = 0;
    await runtime.execute("shell_git_commit", { cwd: root, message: "note", paths: ["note.txt"], push: false });
    const add = calls.find((call) => call.argv.includes("add"));
    assert.ok(add);
    assert.match(add.argv.join(" "), /filter\.example\.driver\.clean=/);
    assert.match(add.argv.join(" "), /filter\.example\.driver\.smudge=/);
    assert.match(add.argv.join(" "), /filter\.example\.driver\.process=/);
  } finally {
    runtime.killAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a policy root cannot contain the audit log", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "grokcode-root-"));
  try {
    const runtime = createShellRuntime({
      platform: "posix",
      home: root,
      loadPolicy: () => ({ policy: policy(root, [{ command: "echo" }]), source: "test" }),
      protectedPaths: [path.join(root, "shell-audit.log")],
    });
    await assert.rejects(() => runtime.execute("shell_run", { cwd: root, argv: ["echo", "hi"] }), /policy root/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("command execution flags stay denied", () => {
  const root = "/work";
  const parsed = parsePolicy(
    JSON.stringify({
      version: 1,
      roots: [root],
      allow: ["ssh", "sed", "awk", "tar", "npm", "npx", "python3.12"].map((command) => ({ command })),
    }),
    "posix",
    "/home/ada",
  );
  const options = { platform: "posix" as const, cwd: root, home: "/home/ada" };
  assert.equal(evaluateCommand(parsed, ["ssh", "-o", "ProxyCommand=id", "host"], options).allow, false);
  assert.equal(evaluateCommand(parsed, ["sed", "s/a/b/e"], options).allow, false);
  assert.equal(evaluateCommand(parsed, ["awk", "{ print | \"sh\" }"], options).allow, false);
  assert.equal(evaluateCommand(parsed, ["tar", "-I", "id", "-xf", "a.tar"], options).allow, false);
  assert.equal(evaluateCommand(parsed, ["npm", "install", "left-pad"], options).allow, false);
  assert.equal(evaluateCommand(parsed, ["npx", "tsx"], options).allow, false);
  assert.match(evaluateCommand(parsed, ["python3.12", "-c", "print(1)"], options).reason, /interpreter/);
  assert.equal(evaluateCommand(parsed, ["npm", "--version"], options).allow, true);
});

test("git_status rejection is a ToolError", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "grokcode-status-"));
  try {
    const runtime = createShellRuntime({
      platform: "posix",
      home: root,
      loadPolicy: () => ({ policy: policy(root, [{ command: "git", subcommands: ["diff"] }]), source: "test" }),
      spawnImpl: () => {
        throw new Error("should not spawn");
      },
    });
    await assert.rejects(
      () => runtime.execute("shell_git_status", { cwd: root }),
      (err: unknown) => err instanceof ToolError && /allowlist/.test(err.message),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

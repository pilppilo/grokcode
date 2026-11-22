import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";

import { ToolError, type PathPlatform } from "grokcode-shared";

import { expandLexical, isFsRoot, isSensitivePath, pathApi, withinRoots } from "./confine.js";
import { branchAllowed, evaluateCommand, type Policy } from "./policy.js";
import { type FileContext } from "./files.js";
import { redact } from "./redact.js";
import { childEnv, defaultSpawn, resolveTrustedCommand, runAndWait, trustedPath, type SpawnFn } from "./spawn.js";

/** Config that stops a repository from running hooks, fsmonitor, filters' helpers, or ext:: remotes. */
export function gitSafetyArgs(platform: PathPlatform): string[] {
  const hooks = platform === "win32" ? "NUL" : "/dev/null";
  return [
    "--no-pager",
    "-c", "core.fsmonitor=",
    "-c", `core.hooksPath=${hooks}`,
    "-c", "protocol.ext.allow=never",
    "-c", "core.sshCommand=",
    "-c", "core.pager=cat",
    "-c", "diff.external=",
  ];
}

export function gitEnv(platform: PathPlatform): NodeJS.ProcessEnv {
  return {
    ...childEnv(process.env, platform),
    HUSKY: "0",
    GIT_NO_LAZY_FETCH: "1",
  };
}

function gitBinary(ctx: FileContext, spawnImpl?: SpawnFn): string {
  if (spawnImpl && spawnImpl !== defaultSpawn) return "git";
  return resolveTrustedCommand("git", {
    platform: ctx.platform,
    pathEnv: trustedPath(ctx.platform),
    roots: ctx.policy.roots,
  });
}

async function runGit(
  binary: string,
  userArgs: readonly string[],
  options: {
    cwd: string;
    ctx: FileContext;
    timeoutMs: number;
    maxOutput: number;
    spawnImpl?: SpawnFn;
    allowlist: boolean;
  },
) {
  if (options.allowlist) {
    const decision = evaluateCommand(options.ctx.policy, ["git", ...userArgs], {
      platform: options.ctx.platform,
      cwd: options.cwd,
      home: options.ctx.home,
    });
    if (!decision.allow) throw new ToolError(decision.reason, "policy_denied");
  }
  const extraConfig = await filterDisableArgs(binary, options.cwd, options.ctx, options.spawnImpl);
  return runAndWait(
    {
      argv: [binary, ...gitSafetyArgs(options.ctx.platform), ...extraConfig, ...userArgs],
      cwd: options.cwd,
      platform: options.ctx.platform,
      shell: false,
      env: gitEnv(options.ctx.platform),
      roots: options.ctx.policy.roots,
    },
    options.timeoutMs,
    options.maxOutput,
    options.spawnImpl,
  );
}

async function filterDisableArgs(
  binary: string,
  cwd: string,
  ctx: FileContext,
  spawnImpl: SpawnFn | undefined,
): Promise<string[]> {
  const listed = await runAndWait(
    {
      argv: [binary, ...gitSafetyArgs(ctx.platform), "config", "--null", "--name-only", "--get-regexp", "^filter\\."],
      cwd, platform: ctx.platform, shell: false, env: gitEnv(ctx.platform), roots: ctx.policy.roots,
    },
    Math.min(8_000, ctx.policy.limits.timeoutMs), 4096, spawnImpl,
  );
  if (listed.timedOut || listed.truncated || (listed.code !== 0 && listed.code !== 1)) {
    throw new ToolError("Could not inspect Git filters.", "git_failed");
  }
  const drivers = new Set<string>();
  for (const key of listed.stdout.split("\0")) {
    if (!key) continue;
    const match = /^filter\.([A-Za-z0-9_.-]+)\.[A-Za-z0-9-]+$/.exec(key);
    if (!match) throw new ToolError("Unsupported Git filter configuration.", "git_failed");
    drivers.add(match[1]!);
  }
  const args: string[] = [];
  for (const name of drivers) {
    for (const mode of ["clean", "smudge", "process"]) args.push("-c", `filter.${name}.${mode}=`);
    args.push("-c", `filter.${name}.required=false`);
  }
  return args;
}

function assertGitDir(dir: string, ctx: FileContext): void {
  let abs = expandLexical(dir.trim(), ctx.platform, ctx.home);
  try {
    abs = expandLexical(fs.realpathSync.native(abs), ctx.platform, ctx.home);
  } catch {
    /* a missing directory is still checked lexically */
  }
  if (isFsRoot(abs, ctx.platform) || !withinRoots(abs, ctx.policy.roots, ctx.platform)) {
    throw new ToolError("Git directory is outside the allowed roots.", "path_denied");
  }
}

/** Apply the same Git safeguards to commands submitted through run_command. */
export async function wrapGitCommand(
  argv: readonly string[],
  ctx: FileContext,
  cwd: string,
  spawnImpl?: SpawnFn,
): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }> {
  const userArgs = argv.slice(1);
  const binary = gitBinary(ctx, spawnImpl);
  const extra = await filterDisableArgs(binary, cwd, ctx, spawnImpl);
  return {
    argv: [binary, ...gitSafetyArgs(ctx.platform), ...extra, ...userArgs],
    env: gitEnv(ctx.platform),
  };
}

export async function assertProjectRepo(cwd: string, ctx: FileContext, spawnImpl?: SpawnFn): Promise<void> {
  const binary = gitBinary(ctx, spawnImpl);
  const results = await Promise.all(["--show-toplevel", "--absolute-git-dir", "--git-common-dir"].map(
    (flag) => runGit(binary, ["rev-parse", "--path-format=absolute", flag], {
      cwd, ctx, timeoutMs: 5_000, maxOutput: 4096, spawnImpl, allowlist: false,
    }),
  ));
  for (const result of results) {
    if (result.code !== 0 || result.truncated) throw new ToolError("Cannot locate the project repository.", "git_failed");
    assertGitDir(result.stdout.trimEnd(), ctx);
  }
}

export async function checkRepo(cwd: string, ctx: FileContext, spawnImpl?: SpawnFn) {
  const binary = gitBinary(ctx, spawnImpl);
  const common = { cwd, ctx, timeoutMs: 5_000, maxOutput: 16_000, spawnImpl };
  await assertProjectRepo(cwd, ctx, spawnImpl);
  const status = await runGit(binary, ["status", "--porcelain=v2", "--branch", "--ignore-submodules=all"], { ...common, allowlist: true });
  if (status.code !== 0 && !status.truncated) throw new ToolError(redact(status.output), "git_failed");
  const lines = status.stdout.trimEnd().split(/\r?\n/);
  const branch = lines.find((line) => line.startsWith("# branch.head "))?.slice(14) ?? null;
  const upstream = lines.find((line) => line.startsWith("# branch.upstream "))?.slice(18) ?? null;
  const counts = lines.find((line) => line.startsWith("# branch.ab "))?.match(/\+(\d+) -(\d+)/);
  const log = lines.includes("# branch.oid (initial)") ? null : await gitInspect(cwd, "log", 5, ctx, spawnImpl);
  return {
    cwd, branch, upstream,
    ahead: counts ? Number(counts[1]) : null,
    behind: counts ? Number(counts[2]) : null,
    status: redact(lines.filter((line) => !line.startsWith("# ")).join("\n")),
    recentCommits: log?.output.trimEnd().split(/\r?\n/) ?? [],
    truncated: status.truncated || Boolean(log?.truncated),
  };
}

export async function gitStatus(cwd: string, ctx: FileContext, spawnImpl?: SpawnFn): Promise<{ cwd: string; output: string }> {
  const binary = gitBinary(ctx, spawnImpl);
  const result = await runGit(binary, ["status", "--porcelain=v1", "-b"], {
    cwd,
    ctx,
    timeoutMs: 20_000,
    maxOutput: ctx.policy.limits.maxOutputBytes,
    spawnImpl,
    allowlist: true,
  });
  if (result.timedOut) throw new ToolError("git status timed out.", "timeout");
  if (result.code !== 0) throw new ToolError(redact(result.output).trim() || "git status failed.", "git_failed");
  return { cwd, output: redact(result.output) };
}

export async function gitInspect(
  cwd: string,
  command: "diff" | "log",
  limit: number,
  ctx: FileContext,
  spawnImpl?: SpawnFn,
  staged = false,
): Promise<{ cwd: string; output: string; truncated: boolean }> {
  const args = command === "diff"
    ? ["diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", ...(staged ? ["--cached"] : [])]
    : ["log", "--no-show-signature", "--no-notes", "--oneline", `--max-count=${limit}`];
  const binary = gitBinary(ctx, spawnImpl);
  const cap = Math.min(32_768, ctx.policy.limits.maxOutputBytes);
  const timeout = Math.min(8_000, ctx.policy.limits.timeoutMs);
  const common = { cwd, ctx, timeoutMs: timeout, maxOutput: 4096, spawnImpl, allowlist: false as const };
  const location = await runGit(binary, ["rev-parse", "--absolute-git-dir"], common);
  if (location.code !== 0 || location.truncated) {
    throw new ToolError(redact(location.output).trim() || "Cannot locate the Git directory.", "git_failed");
  }
  assertGitDir(location.stdout.trimEnd(), ctx);
  const result = await runGit(binary, args, {
    cwd,
    ctx,
    timeoutMs: timeout,
    maxOutput: cap,
    spawnImpl,
    allowlist: true,
  });
  if (result.timedOut) throw new ToolError(`git ${command} timed out.`, "timeout");
  if (result.code !== 0 && !result.truncated) {
    throw new ToolError(redact(result.output).trim() || `git ${command} failed.`, "git_failed");
  }
  const output = redact(result.output);
  return {
    cwd,
    output: new StringDecoder("utf8").write(Buffer.from(output).subarray(0, cap)),
    truncated: result.truncated || Buffer.byteLength(output) > cap,
  };
}

export async function gitCommit(
  options: {
    cwd: string;
    platform: PathPlatform;
    policy: Policy;
    home: string;
    message: string;
    paths: string[];
    push: boolean;
  },
  spawnImpl?: SpawnFn,
): Promise<{ branch: string; output: string; pushed: boolean }> {
  const ctx: FileContext = { policy: options.policy, platform: options.platform, home: options.home };
  const { cwd, platform, policy } = options;
  if (options.message.trim() === "" || options.message.includes("\0") || options.message.length > 5_000) {
    throw new ToolError("commit message is empty, too long, or contains NUL.", "invalid_argument");
  }
  if (options.paths.length === 0) throw new ToolError("paths must name at least one file to commit.", "invalid_argument");
  const path = pathApi(platform);
  for (const rel of options.paths) {
    if (typeof rel !== "string" || rel === "" || path.isAbsolute(rel) || rel.includes("\0")) {
      throw new ToolError("commit paths must be relative to cwd.", "path_denied");
    }
    if (rel.split(/[\\/]/).some((part) => part === "..")) throw new ToolError("commit paths cannot contain ..", "path_denied");
    const abs = path.resolve(cwd, rel);
    if (isSensitivePath(abs, platform)) throw new ToolError("that path cannot be committed.", "path_denied");
  }
  const binary = gitBinary(ctx, spawnImpl);
  const branchResult = await runGit(binary, ["symbolic-ref", "--short", "HEAD"], {
    cwd,
    ctx,
    timeoutMs: 15_000,
    maxOutput: 4_000,
    spawnImpl,
    allowlist: false,
  });
  const branch = branchResult.stdout.trim();
  if (branchResult.code !== 0 || !branchAllowed(branch, policy.git.branches)) {
    throw new ToolError(`branch "${branch || "(unknown)"}" is not in the git branch allowlist.`, "branch_denied");
  }
  const add = await runGit(binary, ["--literal-pathspecs", "add", "--", ...options.paths], {
    cwd,
    ctx,
    timeoutMs: 20_000,
    maxOutput: policy.limits.maxOutputBytes,
    spawnImpl,
    allowlist: false,
  });
  if (add.code !== 0) throw new ToolError(redact(add.output).trim() || "git add failed.", "git_failed");
  const commit = await runGit(binary, ["--literal-pathspecs", "commit", "-m", options.message, "--", ...options.paths], {
    cwd,
    ctx,
    timeoutMs: 30_000,
    maxOutput: policy.limits.maxOutputBytes,
    spawnImpl,
    allowlist: false,
  });
  if (commit.code !== 0) throw new ToolError(redact(commit.output).trim() || "git commit failed.", "git_failed");
  let pushed = false;
  let pushOutput = "";
  if (options.push) {
    if (!policy.git.push) throw new ToolError("git push is disabled in the machine policy.", "push_denied");
    const pushedResult = await runGit(binary, ["push", "origin", `HEAD:${branch}`], {
      cwd,
      ctx,
      timeoutMs: 60_000,
      maxOutput: policy.limits.maxOutputBytes,
      spawnImpl,
      allowlist: false,
    });
    if (pushedResult.code !== 0) throw new ToolError(redact(pushedResult.output).trim() || "git push failed.", "git_failed");
    pushed = true;
    pushOutput = pushedResult.output;
  }
  return { branch, pushed, output: redact([commit.output, pushOutput].filter(Boolean).join("\n")) };
}

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

export interface GitCommitResult {
  branch: string;
  /** Full HEAD SHA after a successful commit. Empty only when Git could not print it. */
  sha: string;
  pushed: boolean;
  output: string;
  /**
   * Present when the commit exists and the requested push did not succeed.
   * Callers must retry the push only; creating another commit would duplicate it.
   */
  committed?: true;
  push?: { ok: false; code: "push_failed" | "timeout"; error: string };
  /** Self-correcting note for a commit that landed and a push that did not. */
  message?: string;
}

/** Tell a caller the commit is already in history and only the push should be retried. */
export function commitPushMessage(sha: string, branch: string, error: string): string {
  const detail = error.length > 500 ? `${error.slice(0, 500)}…` : error;
  const created = sha
    ? `Commit ${sha} was created on branch ${branch || "(unknown)"}.`
    : `A commit was created on branch ${branch || "(unknown)"}, but its SHA could not be read.`;
  return `${created} The push failed: ${detail} This commit already exists. Do not create another commit. Retry only the push.`;
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
): Promise<GitCommitResult> {
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
  // A disabled push must fail before git add or git commit. Otherwise the
  // caller sees push_denied while HEAD already contains the new commit.
  if (options.push && !policy.git.push) {
    throw new ToolError("git push is disabled in the machine policy.", "push_denied");
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
  const sha = await headSha(binary, cwd, ctx, spawnImpl);
  if (!options.push) {
    return { branch, sha, pushed: false, output: redact(commit.output) };
  }
  try {
    const pushedResult = await runGit(binary, ["push", "origin", `HEAD:${branch}`], {
      cwd,
      ctx,
      timeoutMs: 60_000,
      maxOutput: policy.limits.maxOutputBytes,
      spawnImpl,
      allowlist: false,
    });
    if (!pushedResult.timedOut && pushedResult.code === 0) {
      return {
        branch,
        sha,
        pushed: true,
        output: redact([commit.output, pushedResult.output].filter(Boolean).join("\n")),
      };
    }
    const error = pushedResult.timedOut
      ? "git push timed out."
      : redact(pushedResult.output).trim() || "git push failed.";
    return failedPush(branch, sha, commit.output, pushedResult.output, pushedResult.timedOut ? "timeout" : "push_failed", error);
  } catch (err) {
    const error = err instanceof ToolError ? err.message : "git push failed.";
    const code = err instanceof ToolError && err.code === "timeout" ? "timeout" : "push_failed";
    return failedPush(branch, sha, commit.output, "", code, error);
  }
}

function failedPush(
  branch: string,
  sha: string,
  commitOutput: string,
  pushOutput: string,
  code: "push_failed" | "timeout",
  error: string,
): GitCommitResult {
  const pushError = redact(error).trim() || "git push failed.";
  return {
    branch,
    sha,
    committed: true,
    pushed: false,
    output: redact([commitOutput, pushOutput].filter(Boolean).join("\n")),
    push: { ok: false, code, error: pushError },
    message: commitPushMessage(sha, branch, pushError),
  };
}

async function headSha(binary: string, cwd: string, ctx: FileContext, spawnImpl?: SpawnFn): Promise<string> {
  try {
    const result = await runGit(binary, ["rev-parse", "--verify", "HEAD"], {
      cwd,
      ctx,
      timeoutMs: 15_000,
      maxOutput: 4_000,
      spawnImpl,
      allowlist: false,
    });
    if (result.timedOut || result.code !== 0) return "";
    const sha = result.stdout.trim();
    return /^[0-9a-f]{7,64}$/i.test(sha) ? sha : "";
  } catch {
    return "";
  }
}

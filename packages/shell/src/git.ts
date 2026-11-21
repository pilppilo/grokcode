import { ToolError, type PathPlatform } from "grokcode-shared";

import { isSensitivePath, pathApi } from "./confine.js";
import { branchAllowed, type Policy } from "./policy.js";
import { redact } from "./redact.js";
import { runAndWait, type SpawnFn } from "./spawn.js";

export async function gitStatus(
  cwd: string,
  platform: PathPlatform,
  maxOutput: number,
  spawnImpl?: SpawnFn,
): Promise<{ cwd: string; output: string }> {
  const result = await runAndWait(
    { argv: ["git", "status", "--porcelain=v1", "-b"], cwd, platform, shell: false },
    20_000,
    maxOutput,
    spawnImpl,
  );
  if (result.timedOut) throw new ToolError("git status timed out.", "timeout");
  if (result.code !== 0) throw new ToolError(redact(result.output).trim() || "git status failed.", "git_failed");
  return { cwd, output: redact(result.output) };
}

export async function gitCommit(
  options: {
    cwd: string;
    platform: PathPlatform;
    policy: Policy;
    message: string;
    paths: string[];
    push: boolean;
  },
  spawnImpl?: SpawnFn,
): Promise<{ branch: string; output: string; pushed: boolean }> {
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
    if (rel.split(/[\\/]/).includes("..")) throw new ToolError("commit paths cannot contain ..", "path_denied");
    const abs = path.resolve(cwd, rel);
    if (isSensitivePath(abs, platform) || abs.split(/[\\/]/).includes(".git")) {
      throw new ToolError("that path cannot be committed.", "path_denied");
    }
  }
  const branchResult = await runAndWait(
    { argv: ["git", "symbolic-ref", "--short", "HEAD"], cwd, platform, shell: false },
    15_000,
    4_000,
    spawnImpl,
  );
  const branch = branchResult.stdout.trim();
  if (branchResult.code !== 0 || !branchAllowed(branch, policy.git.branches)) {
    throw new ToolError(
      `branch "${branch || "(unknown)"}" is not in the git branch allowlist.`,
      "branch_denied",
    );
  }
  const add = await runAndWait(
    { argv: ["git", "--literal-pathspecs", "add", "--", ...options.paths], cwd, platform, shell: false },
    20_000,
    policy.limits.maxOutputBytes,
    spawnImpl,
  );
  if (add.code !== 0) throw new ToolError(redact(add.output).trim() || "git add failed.", "git_failed");
  const commit = await runAndWait(
    { argv: ["git", "--literal-pathspecs", "commit", "-m", options.message, "--", ...options.paths], cwd, platform, shell: false },
    30_000,
    policy.limits.maxOutputBytes,
    spawnImpl,
  );
  if (commit.code !== 0) throw new ToolError(redact(commit.output).trim() || "git commit failed.", "git_failed");
  let pushed = false;
  let pushOutput = "";
  if (options.push) {
    if (!policy.git.push) throw new ToolError("git push is disabled in the machine policy.", "push_denied");
    const pushedResult = await runAndWait(
      { argv: ["git", "push", "origin", `HEAD:${branch}`], cwd, platform, shell: false },
      60_000,
      policy.limits.maxOutputBytes,
      spawnImpl,
    );
    if (pushedResult.code !== 0) throw new ToolError(redact(pushedResult.output).trim() || "git push failed.", "git_failed");
    pushed = true;
    pushOutput = pushedResult.output;
  }
  return { branch, pushed, output: redact([commit.output, pushOutput].filter(Boolean).join("\n")) };
}

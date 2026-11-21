import { existsSync, readFileSync } from "node:fs";

import { ToolError, asRecord, errorMessage, requiredString, type PathPlatform } from "grokcode-shared";

import { appendAudit, type AuditEvent } from "./audit.js";
import {
  confineCwd,
  confineFile,
  listDir,
  readFile,
  readTextIfExists,
  validatePatchFile,
  removeFile,
  writeFile,
  type FileContext,
} from "./files.js";
import { gitCommit, gitInspect, gitStatus } from "./git.js";
import { searchFiles } from "./search.js";
import { JobTable } from "./jobs.js";
import { applyHunks, parseUnifiedDiff } from "./patch.js";
import { evaluateCommand, evaluateShell, parsePolicy, type LoadedPolicy, type Policy } from "./policy.js";
import { defaultSpawn, type SpawnFn } from "./spawn.js";

export interface ShellRuntimeOptions {
  platform: PathPlatform;
  home: string;
  /** Read on every call so a policy edit applies without a restart. */
  loadPolicy: () => LoadedPolicy;
  auditPath?: string;
  jobs?: JobTable;
  spawnImpl?: SpawnFn;
  now?: () => number;
}

export interface ShellRuntime {
  execute(op: string, params: unknown): Promise<unknown>;
  killAll(): void;
}

export function policyFromFile(file: string | undefined, platform: PathPlatform, home: string): LoadedPolicy {
  if (!file) {
    return { policy: null, source: "(unset)", error: "No policy file. Shell and file tools stay denied." };
  }
  if (!existsSync(file)) {
    return { policy: null, source: file, error: "Policy file was not found. Shell and file tools stay denied." };
  }
  try {
    const policy = parsePolicy(readFileSync(file, "utf8"), platform, home);
    return { policy, source: file };
  } catch (err) {
    return { policy: null, source: file, error: errorMessage(err) };
  }
}

export function createShellRuntime(options: ShellRuntimeOptions): ShellRuntime {
  const jobs = options.jobs ?? new JobTable(options.now);
  const spawnImpl = options.spawnImpl ?? defaultSpawn;

  function audit(event: AuditEvent): void {
    if (options.auditPath) appendAudit(options.auditPath, event);
  }

  async function execute(op: string, params: unknown): Promise<unknown> {
    const record = asRecord(params);
    const loaded = options.loadPolicy();
    const base: AuditEvent = {
      ts: new Date(options.now?.() ?? Date.now()).toISOString(),
      tool: op,
      decision: "deny",
      ...auditFields(record),
    };
    try {
      const result = await dispatch(op, record, loaded);
      const jobId = result && typeof result === "object" && "jobId" in result && typeof result.jobId === "string" ? result.jobId : base.jobId;
      audit({ ...base, decision: "allow", ...(jobId ? { jobId } : {}) });
      return result;
    } catch (err) {
      audit({ ...base, decision: "deny", reason: errorMessage(err) });
      throw err;
    }
  }

  async function dispatch(op: string, record: Record<string, unknown>, loaded: LoadedPolicy): Promise<unknown> {
    if (op === "shell_info") return machineInfo(loaded, options);
    if (op === "shell_kill_job") return jobs.cancel(requiredString(record.jobId, "jobId", 80));
    const policy = requirePolicy(loaded);
    const ctx: FileContext = { policy, platform: options.platform, home: options.home };
    switch (op) {
      case "shell_run":
        return startCommand(record, ctx, jobs, spawnImpl);
      case "shell_job":
        return readJob(record, jobs);
      case "shell_search_files":
        return searchFiles(
          confineCwd(requiredString(record.cwd, "cwd", 4096), ctx),
          requiredString(record.query, "query", 1024),
          record.glob === undefined ? undefined : requiredString(record.glob, "glob", 256),
          ctx,
        );
      case "shell_git_diff":
      case "shell_git_log":
        return gitInspect(
          confineCwd(requiredString(record.cwd, "cwd", 4096), ctx),
          op === "shell_git_diff" ? "diff" : "log",
          numberArg(record.limit, "limit", 1, 100) ?? 20,
          ctx,
          spawnImpl,
        );
      case "shell_read_file": {
        const offset = numberArg(record.offset, "offset", 0, 50_000_000) ?? 0;
        const maxBytes = numberArg(record.maxBytes, "maxBytes", 1, policy.limits.maxReadBytes);
        const start = numberArg(record.startLine, "startLine", 1, 50_000_001);
        const end = numberArg(record.endLine, "endLine", start ?? 1, 50_000_001);
        if (record.offset !== undefined && (start !== undefined || end !== undefined)) {
          throw new ToolError("offset cannot be combined with line ranges.", "invalid_argument");
        }
        return readFile(
          requiredString(record.path, "path", 4096), ctx, offset, maxBytes,
          start !== undefined || end !== undefined ? { start: start ?? 1, end } : undefined,
        );
      }
      case "shell_list_dir":
        return listDir(requiredString(record.path, "path", 4096), ctx);
      case "shell_write_file":
        return writeFile(requiredString(record.path, "path", 4096), contentsArg(record.contents, policy.limits.maxWriteBytes), ctx);
      case "shell_apply_patch":
        return applyPatch(record, ctx);
      case "shell_git_status":
        return gitStatus(
          confineCwd(requiredString(record.cwd, "cwd", 4096), ctx),
          options.platform,
          policy.limits.maxOutputBytes,
          spawnImpl,
        );
      case "shell_git_commit":
        return gitCommit(
          {
            cwd: confineCwd(requiredString(record.cwd, "cwd", 4096), ctx),
            platform: options.platform,
            policy,
            message: requiredString(record.message, "message", 5_000),
            paths: stringArray(record.paths, "paths"),
            push: record.push === true,
          },
          spawnImpl,
        );
      default:
        throw new ToolError(`Unknown shell op ${op}.`, "unknown_op");
    }
  }

  return {
    execute,
    killAll: () => jobs.killAll(),
  };
}

function requirePolicy(loaded: LoadedPolicy): Policy {
  if (!loaded.policy) throw new ToolError(loaded.error ?? "Shell policy is not configured.", "policy_missing");
  return loaded.policy;
}

function machineInfo(loaded: LoadedPolicy, options: ShellRuntimeOptions) {
  const policy = loaded.policy;
  return {
    os: options.platform === "win32" ? "windows" : process.platform === "darwin" ? "mac" : "linux",
    platform: options.platform,
    shell: options.platform === "win32" ? "pwsh" : "bash",
    policyLoaded: Boolean(policy),
    policySource: loaded.source,
    ...(loaded.error ? { policyError: loaded.error } : {}),
    roots: policy?.roots ?? [],
    allowShell: policy?.allowShell ?? false,
    allowInterpreters: policy?.allowInterpreters ?? false,
    commands: policy?.allow.map((rule) => rule.command) ?? [],
    commandRules: policy?.allow.map(({ command, subcommands }) => ({ command, subcommands })) ?? [],
    git: policy?.git ?? { branches: [], push: false },
    limits: policy?.limits ?? null,
  };
}

function startCommand(record: Record<string, unknown>, ctx: FileContext, jobs: JobTable, spawnImpl: SpawnFn) {
  const shell = record.shell === true;
  const cwd = confineCwd(requiredString(record.cwd, "cwd", 4096), ctx);
  const timeoutMs = Math.min(
    numberArg(record.timeoutMs, "timeoutMs", 100, ctx.policy.limits.timeoutMs) ?? ctx.policy.limits.timeoutMs,
    ctx.policy.limits.timeoutMs,
  );
  if (shell) {
    const command = requiredString(record.command, "command", 4000);
    const decision = evaluateShell(ctx.policy, command);
    if (!decision.allow) throw new ToolError(decision.reason, "policy_denied");
    return jobs.start(
      { argv: [], command, cwd, platform: ctx.platform, shell: true },
      timeoutMs,
      ctx.policy.limits.maxOutputBytes,
      spawnImpl,
    );
  }
  const argv = stringArray(record.argv, "argv");
  if (argv.length === 0) throw new ToolError("argv must contain the program and its arguments.", "invalid_argument");
  const decision = evaluateCommand(ctx.policy, argv, { platform: ctx.platform, cwd, home: ctx.home });
  if (!decision.allow) throw new ToolError(decision.reason, "policy_denied");
  return jobs.start({ argv, cwd, platform: ctx.platform, shell: false }, timeoutMs, ctx.policy.limits.maxOutputBytes, spawnImpl);
}

function readJob(record: Record<string, unknown>, jobs: JobTable) {
  const jobId = requiredString(record.jobId, "jobId", 80);
  if (record.view === "poll" || record.offset != null) {
    const offset = numberArg(record.offset, "offset", 0, 10_000_000) ?? 0;
    return jobs.poll(jobId, offset);
  }
  return jobs.get(jobId);
}

function applyPatch(record: Record<string, unknown>, ctx: FileContext) {
  const cwd = confineCwd(requiredString(record.cwd, "cwd", 4096), ctx);
  const files = parseUnifiedDiff(requiredString(record.patch, "patch", 1_000_000));
  const changed: Array<{ path: string; action: "created" | "updated" | "deleted" }> = [];
  const writes: Array<() => void> = [];
  const targets = new Set<string>();
  const reserve = (target: string) => {
    const key = ctx.platform === "win32" ? target.toLowerCase() : target;
    if (targets.has(key)) throw new ToolError("patch touches the same path more than once.", "invalid_patch");
    targets.add(key);
  };
  for (const file of files) {
    const source = file.oldPath == null ? null : locate(file.oldPath, ctx, cwd, false);
    if (file.newPath == null && source) {
      reserve(source);
      applyHunks(readTextIfExists(source, ctx.policy.limits.maxReadBytes), file.hunks);
      writes.push(() => removeFile(source, ctx));
      changed.push({ path: source, action: "deleted" });
      continue;
    }
    const target = locate(file.newPath, ctx, cwd, true);
    reserve(target);
    const original = source == null ? "" : readTextIfExists(source, ctx.policy.limits.maxReadBytes);
    const next = applyHunks(original, file.hunks);
    if (Buffer.byteLength(next) > ctx.policy.limits.maxWriteBytes) {
      throw new ToolError("patched file exceeds the write cap.", "too_large");
    }
    writes.push(() => writeFile(target, next, ctx));
    if (source && source !== target) {
      reserve(source);
      writes.push(() => removeFile(source, ctx));
    }
    changed.push({ path: target, action: source == null ? "created" : "updated" });
  }
  for (const write of writes) write();
  return { cwd, files: changed };
}

function locate(input: string | null, ctx: FileContext, cwd: string, allowMissing: boolean): string {
  if (!input) throw new ToolError("patch file path is missing.", "invalid_patch");
  const target = confineFile(input, ctx, cwd, allowMissing, !allowMissing);
  validatePatchFile(target, allowMissing);
  return target;
}

function contentsArg(value: unknown, maxBytes: number): string {
  if (typeof value !== "string") throw new ToolError("contents is required.", "invalid_argument");
  if (value.includes("\0")) throw new ToolError("contents contains a NUL byte.", "invalid_argument");
  if (Buffer.byteLength(value) > maxBytes) throw new ToolError(`contents exceed the write cap of ${maxBytes} bytes.`, "too_large");
  return value;
}

function stringArray(value: unknown, field: string): string[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ToolError(`${field} must be an array of strings.`, "invalid_argument");
  }
  return value;
}

function numberArg(value: unknown, field: string, min: number, max: number): number | undefined {
  if (value == null || value === "") return undefined;
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ToolError(`${field} must be an integer from ${min} to ${max}.`, "invalid_argument");
  }
  return n;
}

function auditFields(record: Record<string, unknown>): Partial<AuditEvent> {
  const fields: Partial<AuditEvent> = {};
  if (Array.isArray(record.argv)) fields.argv = record.argv.filter((item): item is string => typeof item === "string");
  else if (typeof record.command === "string") fields.argv = [record.command];
  if (typeof record.path === "string") fields.path = record.path;
  if (typeof record.cwd === "string") fields.cwd = record.cwd;
  if (typeof record.jobId === "string") fields.jobId = record.jobId;
  return fields;
}

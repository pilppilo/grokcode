import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";

import { ToolError, asRecord, errorMessage, requiredString, toolErrorPayload, type PathPlatform } from "grokcode-shared";

import { appendAudit, auditMetrics, type AuditEvent } from "./audit.js";
import { CodeExecutions } from "./code-executions.js";
import { editFile } from "./edit.js";
import {
  confineCwd,
  confineFile,
  listDir,
  readFilePage,
  readPage,
  readTextIfExists,
  validatePatchFile,
  removeFile,
  writeFile,
  type FileContext,
} from "./files.js";
import { commandBase, pathApi, withinRoots } from "./confine.js";
import { assertProjectRepo, checkRepo, gitCommit, gitInspect, gitStatus, wrapGitCommand } from "./git.js";
import { guidanceNotice, projectGuidance } from "./guidance.js";
import { searchFiles } from "./search.js";
import { TaskStore } from "./tasks.js";
import { MAX_JOB_HOLD_MS } from "./hold.js";
import { JobTable, type JobView } from "./jobs.js";
import { applyHunks, parseUnifiedDiff } from "./patch.js";
import { evaluateCommand, evaluateShell, parsePolicy, type LoadedPolicy, type Policy } from "./policy.js";
import { defaultSpawn, reapDetachedChildren, type SpawnFn } from "./spawn.js";

export interface ShellRuntimeOptions {
  platform: PathPlatform;
  home: string;
  /** Read on every call so a policy edit applies without a restart. */
  loadPolicy: () => LoadedPolicy;
  auditPath?: string;
  taskDir?: string;
  outputDir?: string;
  enableCodeMode?: boolean;
  /** Protected local state. A root that contains it is refused. */
  protectedPaths?: string[];
  jobs?: JobTable;
  spawnImpl?: SpawnFn;
  now?: () => number;
}

export interface ShellRuntime {
  execute(op: string, params: unknown, signal?: AbortSignal): Promise<unknown>;
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
    if (withinRoots(path.resolve(file), policy.roots, platform)) {
      return {
        policy: null,
        source: file,
        error: "A policy root contains the policy file. Move the root so it does not cover it.",
      };
    }
    return { policy, source: file };
  } catch (err) {
    return { policy: null, source: file, error: errorMessage(err) };
  }
}

const projectPathField: Partial<Record<string, "path" | "cwd">> = {
  shell_run: "cwd",
  shell_check_repo: "cwd",
  shell_run_tests: "cwd",
  shell_run_task: "cwd",
  shell_git_status: "cwd",
  shell_git_diff: "cwd",
  shell_git_log: "cwd",
  shell_git_commit: "cwd",
  shell_read_file: "path",
  shell_list_dir: "path",
  shell_write_file: "path",
  shell_edit_file: "path",
  shell_search_files: "cwd",
  shell_apply_patch: "cwd",
};

export function createShellRuntime(options: ShellRuntimeOptions): ShellRuntime {
  const jobs = options.jobs ?? new JobTable(options.now, undefined, options.outputDir);
  const tasks = options.taskDir ? new TaskStore(options.taskDir, jobs) : undefined;
  const spawnImpl = options.spawnImpl ?? defaultSpawn;
  const code = options.enableCodeMode && options.auditPath
    ? new CodeExecutions((op, args, signal, sessionScope) => execute(op, { ...asRecord(args), sessionScope }, signal, true))
    : undefined;

  function audit(event: AuditEvent): boolean {
    return !!options.auditPath && appendAudit(options.auditPath, event);
  }

  async function execute(op: string, params: unknown, signal?: AbortSignal, requireAudit = false): Promise<unknown> {
    const started = performance.now();
    const { sessionScope: scope, ...record } = asRecord(params);
    const sessionScope = typeof scope === "string" && /^[A-Za-z0-9_-]{43}$/.test(scope) ? scope : undefined;
    const base = {
      ts: new Date(options.now?.() ?? Date.now()).toISOString(),
      tool: op,
      decision: "deny" as const,
      sessionId: sessionScope ?? null,
      ...auditFields(op === "shell_send_input" ? { jobId: record.jobId } : record),
    };
    try {
      signal?.throwIfAborted();
      const loaded = isolateRoots(options.loadPolicy(), options.platform, [
        ...(options.protectedPaths ?? []),
        ...(options.auditPath ? [options.auditPath, `${options.auditPath}.1`] : []),
        ...(options.taskDir ? [options.taskDir] : []),
        ...(options.outputDir ? [options.outputDir] : []),
      ]);
      const result = op === "shell_send_input"
        ? await sendInput(record, loaded, sessionScope, () => {
            if (!audit({ ...base, ...auditMetrics(started), decision: "allow", phase: "admission" })) {
              throw new ToolError("Job input audit is unavailable.", "audit_unavailable");
            }
          })
        : await dispatch(op, record, loaded, signal, sessionScope);
      const jobId = result && typeof result === "object" && "jobId" in result && typeof result.jobId === "string" ? result.jobId : base.jobId;
      const recorded = audit({ ...base, ...auditMetrics(started, result), decision: "allow", ...(jobId ? { jobId } : {}) });
      if (requireAudit && !recorded) throw new ToolError("Nested read audit is unavailable.", "audit_unavailable");
      return result;
    } catch (err) {
      audit({ ...base, ...auditMetrics(started, toolErrorPayload(err)), decision: "deny", reason: errorMessage(err) });
      throw err;
    }
  }

  async function sendInput(record: Record<string, unknown>, loaded: LoadedPolicy, sessionScope: string | undefined, beforeWrite: () => void) {
    const policy = requirePolicy(loaded);
    if (!policy.allowJobInput) throw new ToolError("Job input is disabled by policy.", "policy_denied");
    const jobId = requiredString(record.jobId, "jobId", 80);
    const input = record.input;
    if (typeof input !== "string" || input.length === 0 || input.length > 4096) {
      throw new ToolError("input must contain 1 to 4096 characters.", "invalid_argument");
    }
    confineCwd(jobs.get(jobId, sessionScope).cwd, { policy, platform: options.platform, home: options.home });
    await jobs.sendInput(jobId, input, beforeWrite, sessionScope);
    return { jobId };
  }

  async function dispatch(op: string, record: Record<string, unknown>, loaded: LoadedPolicy, signal?: AbortSignal, sessionScope?: string): Promise<unknown> {
    if (op === "shell_info") return machineInfo(loaded, options);
    if (op === "shell_kill_job") return jobs.cancel(requiredString(record.jobId, "jobId", 80), sessionScope);
    const policy = requirePolicy(loaded);
    if (op === "shell_list_jobs") return jobs.list(sessionScope);
    if (op === "shell_code_execute" || op === "shell_code_poll" || op === "shell_code_cancel") {
      if (!code) throw new ToolError("Code mode is disabled on this agent.", "code_disabled");
      return code.dispatch(op, record, signal, sessionScope);
    }
    if (op === "shell_job") {
      if (options.outputDir) {
        const jobId = requiredString(record.jobId, "jobId", 80);
        confineCwd(jobs.get(jobId, sessionScope).cwd, { policy, platform: options.platform, home: options.home });
      }
      return readJob(record, jobs, signal, sessionScope);
    }
    if (op === "shell_task_status" || op === "shell_task_activity" || op === "shell_cancel_task") {
      if (!tasks) throw new ToolError("Task storage is unavailable.", "task_unavailable");
      const id = requiredString(record.taskId, "taskId", 80);
      if (op === "shell_cancel_task") return tasks.cancel(id, sessionScope);
      if (op === "shell_task_activity") return tasks.activity(id, numberArg(record.offset, "offset", 0, 10_000_000) ?? 0, sessionScope);
      return tasks.status(id, sessionScope);
    }
    const ctx: FileContext = { policy, platform: options.platform, home: options.home };
    if (op === "shell_read_file" && typeof record.path === "string" && record.path.startsWith("grokcode-output:")) {
      if (record.project !== undefined) throw new ToolError("Omit project when reading a job output file.", "invalid_argument");
      const jobId = record.path.slice("grokcode-output:".length);
      const { cwd, file } = jobs.savedOutput(jobId, sessionScope);
      confineCwd(cwd, ctx);
      return { ...await readPage(file, policy.limits.maxReadBytes, readPageOptions(record, policy), true, signal), path: record.path };
    }
    const field = projectPathField[op];
    if (field && (record.project !== undefined || op === "shell_check_repo" || op === "shell_run_tests" || op === "shell_run_task")) {
      const name = requiredString(record.project, "project", 64);
      const projects = policy.projects ?? {};
      const project = Object.hasOwn(projects, name) ? projects[name] : undefined;
      if (!project) {
        throw new ToolError(`Unknown project "${name}". Available projects: ${Object.keys(projects).join(", ") || "(none)"}.`, "unknown_project");
      }
      const root = confineCwd(project.root, ctx);
      if (!withinRoots(root, [project.root], options.platform)) {
        throw new ToolError("The project root resolves outside its configured directory.", "path_denied");
      }
      ctx.policy = { ...policy, roots: [root] };
      const input = record[field];
      const target = input === undefined ? "." : requiredString(input, field, 4096);
      record = { ...record, [field]: pathApi(options.platform).resolve(root, target) };
      if (op === "shell_git_diff" || op === "shell_git_log") {
        await assertProjectRepo(confineCwd(record.cwd as string, ctx), ctx, spawnImpl);
      }
      if (op === "shell_run" && record.shell === true) {
        throw new ToolError("Project commands require argv.", "invalid_argument");
      }
      if (op === "shell_check_repo") {
        if (pathApi(ctx.platform).parse(target).root) {
          throw new ToolError("check_repo cwd must be project-relative.", "invalid_path");
        }
        const cwd = confineCwd(record.cwd as string, ctx);
        if (!lstatSync(cwd).isDirectory()) throw new ToolError("cwd is not a directory.", "invalid_path");
        const summary = await checkRepo(root, ctx, spawnImpl);
        return { ...summary, guidance: projectGuidance(root, cwd, ctx) };
      }
      if (op === "shell_run_task") {
        if (!tasks) throw new ToolError("Task storage is unavailable.", "task_unavailable");
        const command = record.task === undefined ? "test" : requiredString(record.task, "task", 64);
        const argv = command === "test" ? project.testCommand : project.taskCommands?.[command];
        if (!argv || !Array.isArray(argv)) throw new ToolError(`This project has no configured ${command} command.`, "invalid_argument");
        const result = await tasks.start(name, command, (publish, capture) => startCommand(
          { cwd: root, argv }, ctx, jobs, spawnImpl, sessionScope, true, publish, capture,
        ), root, sessionScope);
        return { ...result, guidance: guidanceNotice(root, root, ctx) };
      }
      if (op === "shell_run_tests") {
        if (!project.testCommand) throw new ToolError("This project has no configured test command.", "invalid_argument");
        const filter = record.filter;
        if (filter !== undefined && (typeof filter !== "string" || !/^[a-zA-Z0-9_][a-zA-Z0-9_. /:-]{0,255}$/.test(filter))) {
          throw new ToolError("Invalid test filter.", "invalid_argument");
        }
        const argv = filter === undefined ? project.testCommand : [...project.testCommand, filter];
        const result = await startCommand({ cwd: root, argv }, ctx, jobs, spawnImpl, sessionScope, true);
        return { ...result, guidance: guidanceNotice(root, root, ctx) };
      }
      const cwd = field === "cwd" ? confineCwd(record.cwd as string, ctx) : undefined;
      const result = asRecord(await dispatchShell(op, record, ctx, signal, sessionScope));
      const resultPath = result.path as string;
      const scope = cwd ?? (op === "shell_list_dir" ? resultPath : pathApi(ctx.platform).dirname(resultPath));
      return { ...result, guidance: guidanceNotice(root, scope, ctx) };
    }
    return dispatchShell(op, record, ctx, signal, sessionScope);
  }

  async function dispatchShell(op: string, record: Record<string, unknown>, ctx: FileContext, signal?: AbortSignal, sessionScope?: string): Promise<unknown> {
    const { policy } = ctx;
    switch (op) {
      case "shell_run":
        return startCommand(record, ctx, jobs, spawnImpl, sessionScope);
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
          record.staged === true,
        );
      case "shell_read_file": {
        return readFilePage(requiredString(record.path, "path", 4096), ctx, readPageOptions(record, policy), signal);
      }
      case "shell_list_dir":
        return listDir(requiredString(record.path, "path", 4096), ctx);
      case "shell_write_file":
        return writeFile(requiredString(record.path, "path", 4096), contentsArg(record.contents, policy.limits.maxWriteBytes), ctx);
      case "shell_edit_file": {
        if (record.replaceAll !== undefined && typeof record.replaceAll !== "boolean") {
          throw new ToolError("replaceAll must be a boolean.", "invalid_argument");
        }
        return editFile(
          requiredString(record.path, "path", 4096),
          contentsArg(record.oldText, policy.limits.maxReadBytes, "oldText"),
          contentsArg(record.newText, policy.limits.maxWriteBytes, "newText"),
          record.replaceAll === true, ctx, signal,
        );
      }
      case "shell_apply_patch":
        return applyPatch(record, ctx);
      case "shell_git_status":
        return gitStatus(confineCwd(requiredString(record.cwd, "cwd", 4096), ctx), ctx, spawnImpl);
      case "shell_git_commit":
        return gitCommit(
          {
            cwd: confineCwd(requiredString(record.cwd, "cwd", 4096), ctx),
            platform: options.platform,
            policy: ctx.policy,
            home: options.home,
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
    killAll: () => {
      code?.cancelAll();
      jobs.killAll();
      reapDetachedChildren();
    },
  };
}

function isolateRoots(loaded: LoadedPolicy, platform: PathPlatform, protectedPaths: readonly string[] | undefined): LoadedPolicy {
  if (!loaded.policy || !protectedPaths || protectedPaths.length === 0) return loaded;
  for (const file of protectedPaths) {
    if (withinRoots(path.resolve(file), loaded.policy.roots, platform)) {
      return {
        policy: null,
        source: loaded.source,
        error: "A policy root contains the policy file or the audit log. Move the root so it does not cover them.",
      };
    }
  }
  return loaded;
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
    projects: Object.entries(policy?.projects ?? {}).map(([name, { root, defaultBranch, testCommand, taskCommands }]) => ({
      name, root, defaultBranch, hasTestCommand: Boolean(testCommand), tasks: [...(testCommand ? ["test"] : []), ...Object.keys(taskCommands ?? {})],
    })),
    allowShell: policy?.allowShell ?? false,
    allowJobInput: policy?.allowJobInput ?? false,
    allowInterpreters: policy?.allowInterpreters ?? false,
    commands: policy?.allow.map((rule) => rule.command) ?? [],
    commandRules: policy?.allow.map(({ command, subcommands }) => ({ command, subcommands })) ?? [],
    git: policy?.git ?? { branches: [], push: false },
    limits: policy?.limits ?? null,
  };
}

async function startCommand(record: Record<string, unknown>, ctx: FileContext, jobs: JobTable, spawnImpl: SpawnFn, sessionScope?: string, keepTail = false, onChange?: (view: JobView) => void, onOutput?: (chunk: Buffer | string) => void) {
  const shell = record.shell === true;
  const stdin = record.stdin === true;
  if (stdin && !ctx.policy.allowJobInput) throw new ToolError("Job input is disabled by policy.", "policy_denied");
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
      { argv: [], command, cwd, platform: ctx.platform, shell: true, stdin },
      timeoutMs,
      ctx.policy.limits.maxOutputBytes,
      spawnImpl, keepTail, onChange, onOutput, ctx.policy.limits.outputPreviewBytes, sessionScope,
    );
  }
  const argv = stringArray(record.argv, "argv");
  if (argv.length === 0) throw new ToolError("argv must contain the program and its arguments.", "invalid_argument");
  const decision = evaluateCommand(ctx.policy, argv, { platform: ctx.platform, cwd, home: ctx.home });
  if (!decision.allow) throw new ToolError(decision.reason, "policy_denied");
  if (commandBase(argv[0] ?? "", ctx.platform) === "git") {
    if (record.project !== undefined || keepTail) await assertProjectRepo(cwd, ctx, spawnImpl);
    const wrapped = await wrapGitCommand(argv, ctx, cwd, spawnImpl);
    return jobs.start(
      { argv: wrapped.argv, cwd, platform: ctx.platform, shell: false, stdin, env: wrapped.env, roots: ctx.policy.roots },
      timeoutMs,
      ctx.policy.limits.maxOutputBytes,
      spawnImpl, keepTail, onChange, onOutput, ctx.policy.limits.outputPreviewBytes, sessionScope,
    );
  }
  return jobs.start(
    { argv, cwd, platform: ctx.platform, shell: false, stdin, roots: ctx.policy.roots },
    timeoutMs,
    ctx.policy.limits.maxOutputBytes,
    spawnImpl, keepTail, onChange, onOutput, ctx.policy.limits.outputPreviewBytes, sessionScope,
  );
}

function readPageOptions(record: Record<string, unknown>, policy: Policy) {
  const offset = numberArg(record.offset, "offset", 0, Number.MAX_SAFE_INTEGER);
  const maxBytes = numberArg(record.maxBytes, "maxBytes", 1, policy.limits.maxReadBytes);
  const startLine = numberArg(record.startLine, "startLine", 1, Number.MAX_SAFE_INTEGER);
  const endLine = numberArg(record.endLine, "endLine", startLine ?? 1, Number.MAX_SAFE_INTEGER);
  return { offset, maxBytes, startLine, endLine };
}

function readJob(record: Record<string, unknown>, jobs: JobTable, signal?: AbortSignal, sessionScope?: string) {
  const jobId = requiredString(record.jobId, "jobId", 80);
  if (record.view === "poll" || record.offset != null) {
    const offset = numberArg(record.offset, "offset", 0, Number.MAX_SAFE_INTEGER) ?? 0;
    return jobs.poll(jobId, offset, sessionScope);
  }
  const holdMs = numberArg(record.holdMs, "holdMs", 0, MAX_JOB_HOLD_MS) ?? 0;
  return jobs.wait(jobId, holdMs, signal, sessionScope);
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

function contentsArg(value: unknown, maxBytes: number, field = "contents"): string {
  if (typeof value !== "string") throw new ToolError(`${field} is required.`, "invalid_argument");
  if (value.includes("\0")) throw new ToolError(`${field} contains a NUL byte.`, "invalid_argument");
  if (Buffer.byteLength(value) > maxBytes) {
    const message = field === "contents"
      ? `contents exceed the write cap of ${maxBytes} bytes.`
      : `${field} exceeds the size cap of ${maxBytes} bytes.`;
    throw new ToolError(message, "too_large");
  }
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

function auditFields(record: Record<string, unknown>): Partial<Pick<AuditEvent, "argv" | "path" | "paths" | "cwd" | "jobId">> {
  const fields: Partial<Pick<AuditEvent, "argv" | "path" | "paths" | "cwd" | "jobId">> = {};
  if (Array.isArray(record.argv)) fields.argv = record.argv.filter((item): item is string => typeof item === "string");
  else if (typeof record.command === "string") fields.argv = [record.command];
  if (typeof record.path === "string") fields.path = record.path;
  if (typeof record.cwd === "string") fields.cwd = record.cwd;
  if (typeof record.jobId === "string") fields.jobId = record.jobId;
  if (Array.isArray(record.paths)) {
    const paths = record.paths.filter((item): item is string => typeof item === "string");
    if (paths.length > 0) fields.paths = paths;
  } else if (typeof record.patch === "string") {
    const paths = [...record.patch.matchAll(/^(?:\+\+\+|---) (?:[ab]\/)?(\S+)/gm)]
      .map((match) => match[1] ?? "")
      .filter((item) => item !== "" && item !== "/dev/null");
    if (paths.length > 0) fields.paths = [...new Set(paths)];
  }
  return fields;
}

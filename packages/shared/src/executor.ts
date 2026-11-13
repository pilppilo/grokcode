import { assertDirectoryAllowed, detectPlatform, directoryAllowed, type PathPlatform } from "./paths.js";
import { parseToolOutputMode, type ToolOutputMode } from "./messages.js";
import { OpenCodeClient, type FormView, type PermissionView, type ProjectInfo, type SessionSummary } from "./opencode.js";
import { asRecord, assertId, isOpName, optionalString, requiredString, type OpName } from "./protocol.js";
import { ToolError } from "./errors.js";

export interface OpenCodeStatus {
  reachable: boolean;
  url: string;
  version?: string;
  api?: "v1" | "v2";
  pid?: number;
  /** True when this call started a server. False when one was already reachable. */
  started?: boolean;
  /**
   * When reachable, true if the listener is OpenCode's managed service
   * (the url or pid in ~/.local/state/opencode/service.json). Never a password.
   */
  managedService?: boolean;
}

export interface OpenCodeControl {
  status(): Promise<OpenCodeStatus>;
  /** Start OpenCode only for an explicit start_opencode call. Must not stop it later. */
  start(directory?: string): Promise<OpenCodeStatus>;
}

export interface ExecutorContext {
  /** Absent when OpenCode is not reachable yet. */
  api?: OpenCodeClient;
  allowDirs?: readonly string[];
  platform?: PathPlatform;
  home?: string;
  /** provider/model applied when start_session or send_prompt omits model. */
  defaultModel?: string;
  opencodeControl?: OpenCodeControl;
}

function ctxOf(ctx: ExecutorContext) {
  const api = ctx.api;
  if (!api) {
    throw new ToolError(
      "OpenCode is unavailable. The agent keeps retrying and does not start a server on its own. Call start_opencode only when the user explicitly asks to open or start OpenCode.",
      "opencode_unavailable",
    );
  }
  return {
    api,
    allowDirs: ctx.allowDirs ?? [],
    platform: ctx.platform ?? detectPlatform(),
    home: ctx.home ?? homedir(),
    ...(ctx.defaultModel ? { defaultModel: ctx.defaultModel } : {}),
  };
}

function suppliedModel(value: unknown): unknown {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
  }
  if (value && typeof value === "object") return value;
  return undefined;
}

function effectiveModel(value: unknown, fallback: string | undefined): unknown {
  return suppliedModel(value) ?? fallback;
}

function homedir(): string {
  return process.env.HOME || process.env.USERPROFILE || "/";
}

function numberArg(value: unknown, field: string, min: number, max: number): number | undefined {
  if (value == null || value === "") return undefined;
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ToolError(`${field} must be an integer from ${min} to ${max}.`, "invalid_argument");
  }
  return n;
}

function boolArg(value: unknown, field: string, fallback: boolean): boolean {
  if (value == null || value === "") return fallback;
  if (value === true || value === "true" || value === 1 || value === "1") return true;
  if (value === false || value === "false" || value === 0 || value === "0") return false;
  throw new ToolError(`${field} must be a boolean.`, "invalid_argument");
}

function orderArg(value: unknown): "asc" | "desc" {
  if (value == null || value === "") return "desc";
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (text === "asc" || text === "desc") return text;
  throw new ToolError("order must be asc or desc.", "invalid_argument");
}

function toolOutputArg(value: unknown, fallback: ToolOutputMode): ToolOutputMode {
  if (value == null || value === "") return fallback;
  return parseToolOutputMode(value);
}

function filterSessions(sessions: SessionSummary[], allowDirs: readonly string[], platform: PathPlatform, home: string) {
  if (allowDirs.length === 0) return sessions;
  return sessions.filter((session) => directoryAllowed(session.directory, allowDirs, platform, home));
}

function filterProjects(projects: ProjectInfo[], allowDirs: readonly string[], platform: PathPlatform, home: string) {
  if (allowDirs.length === 0) return projects;
  return projects.filter((project) => !project.directory || directoryAllowed(project.directory, allowDirs, platform, home));
}

async function filterPermissions(
  items: PermissionView[],
  api: OpenCodeClient,
  allowDirs: readonly string[],
  platform: PathPlatform,
  home: string,
): Promise<PermissionView[]> {
  if (allowDirs.length === 0) return items;
  const cache = new Map<string, string | undefined>();
  const kept: PermissionView[] = [];
  for (const item of items) {
    if (!item.sessionId) continue;
    if (!cache.has(item.sessionId)) {
      try {
        const session = await api.getSession(item.sessionId);
        cache.set(item.sessionId, session.directory);
      } catch {
        cache.set(item.sessionId, undefined);
      }
    }
    if (directoryAllowed(cache.get(item.sessionId), allowDirs, platform, home)) kept.push(item);
  }
  return kept;
}

async function filterForms(
  items: FormView[],
  api: OpenCodeClient,
  allowDirs: readonly string[],
  platform: PathPlatform,
  home: string,
): Promise<FormView[]> {
  if (allowDirs.length === 0) return items;
  const cache = new Map<string, string | undefined>();
  const kept: FormView[] = [];
  for (const item of items) {
    if (!item.sessionId) continue;
    if (!cache.has(item.sessionId)) {
      try {
        const session = await api.getSession(item.sessionId);
        cache.set(item.sessionId, session.directory);
      } catch {
        cache.set(item.sessionId, undefined);
      }
    }
    if (directoryAllowed(cache.get(item.sessionId), allowDirs, platform, home)) kept.push(item);
  }
  return kept;
}

/**
 * Run one allowlisted OpenCode operation. The relay never forwards raw HTTP;
 * both the agent and tests go through this function.
 */
export async function executeOp(ctxIn: ExecutorContext, op: string, params: unknown): Promise<unknown> {
  if (!isOpName(op)) throw new ToolError(`Unknown op ${op}.`, "unknown_op");
  if (op === "opencode_status" || op === "start_opencode") {
    return runOpenCodeControl(ctxIn, op, params);
  }
  const ctx = ctxOf(ctxIn);
  const p = asRecord(params);
  const guardDir = (directory: string | undefined) =>
    assertDirectoryAllowed(directory, ctx.allowDirs, ctx.platform, ctx.home);

  switch (op as OpName) {
    case "server_info": {
      const info = await ctx.api.serverInfo();
      return { ...info, defaultModel: ctx.defaultModel ?? null };
    }
    case "list_projects":
      return { projects: filterProjects(await ctx.api.listProjects(), ctx.allowDirs, ctx.platform, ctx.home) };
    case "list_sessions": {
      const directory = optionalString(p.directory);
      if (directory) guardDir(directory);
      const sessions = await ctx.api.listSessions({
        directory,
        limit: numberArg(p.limit, "limit", 1, 100),
        search: optionalString(p.search),
      });
      return { sessions: filterSessions(sessions, ctx.allowDirs, ctx.platform, ctx.home) };
    }
    case "start_session": {
      const directory = requiredString(p.directory, "directory", 4096);
      guardDir(directory);
      const session = await ctx.api.startSession({
        directory,
        title: optionalString(p.title),
        agent: optionalString(p.agent),
        model: effectiveModel(p.model, ctx.defaultModel),
      });
      return { session };
    }
    case "send_prompt": {
      const sessionId = assertId(p.sessionId, "sessionId");
      await guardSession(ctx, sessionId);
      const accepted = await ctx.api.sendPrompt({
        sessionId,
        text: requiredString(p.text, "text"),
        agent: optionalString(p.agent),
        model: effectiveModel(p.model, ctx.defaultModel),
      });
      return accepted;
    }
    case "get_messages": {
      const sessionId = assertId(p.sessionId, "sessionId");
      await guardSession(ctx, sessionId);
      return ctx.api.listMessages(sessionId, {
        limit: numberArg(p.limit, "limit", 1, 200),
        tail: numberArg(p.tail ?? p.last, "tail", 1, 200),
        order: orderArg(p.order),
        includeReasoning: boolArg(p.includeReasoning, "includeReasoning", false),
        includeToolOutput: toolOutputArg(p.includeToolOutput, "summary"),
      });
    }
    case "get_message": {
      const sessionId = assertId(p.sessionId, "sessionId");
      await guardSession(ctx, sessionId);
      return ctx.api.getMessage(sessionId, assertId(p.messageId, "messageId"), {
        partOffset: numberArg(p.partOffset, "partOffset", 0, 100_000),
        partLimit: numberArg(p.partLimit, "partLimit", 1, 100),
        offset: numberArg(p.offset, "offset", 0, 50_000_000),
        maxChars: numberArg(p.maxChars, "maxChars", 1, 60_000),
        includeReasoning: boolArg(p.includeReasoning, "includeReasoning", false),
        includeToolOutput: toolOutputArg(p.includeToolOutput, "full"),
      });
    }
    case "get_session": {
      const sessionId = assertId(p.sessionId, "sessionId");
      const session = await guardSession(ctx, sessionId);
      return { session };
    }
    case "get_session_summary": {
      const sessionId = assertId(p.sessionId, "sessionId");
      const session = await guardSession(ctx, sessionId);
      return ctx.api.summarizeSession(session);
    }
    case "get_diff": {
      const sessionId = assertId(p.sessionId, "sessionId");
      await guardSession(ctx, sessionId);
      const messageId = optionalString(p.messageId);
      const diff = await ctx.api.getDiff(sessionId, messageId);
      return { diff };
    }
    case "list_pending_permissions": {
      const sessionId = optionalString(p.sessionId);
      const directory = optionalString(p.directory);
      if (sessionId) await guardSession(ctx, sessionId);
      if (directory) guardDir(directory);
      let permissions = await ctx.api.listPermissions({ sessionId, directory });
      if (!sessionId) permissions = await filterPermissions(permissions, ctx.api, ctx.allowDirs, ctx.platform, ctx.home);
      return { permissions };
    }
    case "respond_permission": {
      const sessionId = assertId(p.sessionId, "sessionId");
      await guardSession(ctx, sessionId);
      return ctx.api.respondPermission({
        sessionId,
        requestId: assertId(p.requestId, "requestId"),
        decision: p.decision,
        message: optionalString(p.message),
      });
    }
    case "abort": {
      const sessionId = assertId(p.sessionId, "sessionId");
      await guardSession(ctx, sessionId);
      return ctx.api.abort(sessionId);
    }
    case "list_agents": {
      const directory = optionalString(p.directory);
      if (directory) guardDir(directory);
      if (ctx.allowDirs.length > 0 && !directory) {
        throw new ToolError("directory is required when the agent allowlist is set.", "directory_denied");
      }
      return { agents: await ctx.api.listAgents(directory) };
    }
    case "list_models": {
      const directory = optionalString(p.directory);
      if (directory) guardDir(directory);
      return { models: await ctx.api.listModels(directory) };
    }
    case "run_command": {
      const sessionId = assertId(p.sessionId, "sessionId");
      await guardSession(ctx, sessionId);
      return ctx.api.runCommand({
        sessionId,
        command: requiredString(p.command, "command", 200),
        arguments: optionalString(p.arguments),
        agent: optionalString(p.agent),
      });
    }
    case "list_forms": {
      const sessionId = optionalString(p.sessionId);
      const directory = optionalString(p.directory);
      if (sessionId) await guardSession(ctx, sessionId);
      if (directory) guardDir(directory);
      let forms = await ctx.api.listForms({ sessionId, directory });
      if (!sessionId) forms = await filterForms(forms, ctx.api, ctx.allowDirs, ctx.platform, ctx.home);
      return { forms };
    }
    case "reply_form": {
      const sessionId = assertId(p.sessionId, "sessionId");
      await guardSession(ctx, sessionId);
      if (p.answer == null) throw new ToolError("answer is required.", "invalid_argument");
      return ctx.api.replyForm({
        sessionId,
        formId: assertId(p.formId, "formId"),
        answer: p.answer,
      });
    }
    case "delete_session": {
      const sessionId = assertId(p.sessionId, "sessionId");
      await guardSession(ctx, sessionId);
      return ctx.api.deleteSession(sessionId);
    }
    default:
      throw new ToolError(`Unknown op ${op}.`, "unknown_op");
  }
}

async function runOpenCodeControl(
  ctx: ExecutorContext,
  op: "opencode_status" | "start_opencode",
  params: unknown,
): Promise<OpenCodeStatus> {
  const control = ctx.opencodeControl;
  if (!control) throw new ToolError(`${op} is not available on this connection.`, "unsupported");
  if (op === "opencode_status") return control.status();
  const directory = optionalString(asRecord(params).directory);
  if (directory) {
    assertDirectoryAllowed(directory, ctx.allowDirs ?? [], ctx.platform ?? detectPlatform(), ctx.home ?? homedir());
  }
  return control.start(directory);
}

async function guardSession(
  ctx: { api: OpenCodeClient; allowDirs: readonly string[]; platform: PathPlatform; home: string },
  sessionId: string,
) {
  const session = await ctx.api.getSession(sessionId);
  assertDirectoryAllowed(session.directory, ctx.allowDirs, ctx.platform, ctx.home);
  return session;
}

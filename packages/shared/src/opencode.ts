import { basicAuthHeader } from "./auth.js";
import { GrokcodeError } from "./errors.js";
import { assertId, optionalString } from "./protocol.js";

export type ApiGeneration = "v1" | "v2";

export interface OpenCodeAuth {
  username: string;
  password?: string;
}

export interface FetchLike {
  (input: string, init?: RequestInit): Promise<Response>;
}

export interface ServerInfo {
  api: ApiGeneration;
  version?: string;
  healthy: boolean;
  raw: unknown;
}

export interface ProjectInfo {
  id?: string;
  name?: string;
  directory?: string;
  raw: unknown;
}

export interface SessionSummary {
  id: string;
  title?: string;
  directory?: string;
  parentId?: string;
  raw: unknown;
}

export interface SessionView {
  id: string;
  title?: string;
  directory?: string;
  activity: "idle" | "busy" | "retry" | "unknown";
  raw: unknown;
  status?: unknown;
}

export interface MessageView {
  id?: string;
  role?: string;
  text: string;
  raw: unknown;
}

export interface PromptAccepted {
  sessionId: string;
  messageId?: string;
  accepted: true;
  raw: unknown;
}

export interface PermissionView {
  id: string;
  sessionId?: string;
  action?: string;
  resources?: string[];
  raw: unknown;
}

export interface DiffView {
  file?: string;
  additions?: number;
  deletions?: number;
  patch?: string;
  status?: string;
  raw: unknown;
}

export interface NamedInfo {
  id: string;
  name?: string;
  providerId?: string;
  raw: unknown;
}

export interface FormView {
  id: string;
  sessionId?: string;
  title?: string;
  raw: unknown;
}

export interface ModelRef {
  id: string;
  providerID: string;
  variant?: string;
}

const HTML_ERROR =
  "OpenCode returned HTML for this route. On v2, un-prefixed paths such as /session are the web UI, not the API. Use a server that exposes /api/info.";

export class OpenCodeError extends GrokcodeError {
  constructor(message: string, status?: number, details?: unknown) {
    super(message, status === 401 ? "opencode_unauthorized" : "opencode_error", status, details);
    this.name = "OpenCodeError";
  }
}

export function parseModel(input: unknown): ModelRef | undefined {
  if (input == null || input === "") return undefined;
  if (typeof input === "string") {
    const slash = input.indexOf("/");
    if (slash <= 0 || slash === input.length - 1) {
      throw new OpenCodeError("model must look like provider/model, for example anthropic/claude-sonnet-5.");
    }
    return { providerID: input.slice(0, slash), id: input.slice(slash + 1) };
  }
  if (typeof input === "object") {
    const record = input as Record<string, unknown>;
    const providerID = optionalString(record.providerID) ?? optionalString(record.providerId);
    const id = optionalString(record.id) ?? optionalString(record.modelID) ?? optionalString(record.modelId);
    if (!providerID || !id) {
      throw new OpenCodeError("model object needs providerID and id.");
    }
    const variant = optionalString(record.variant);
    return variant ? { providerID, id, variant } : { providerID, id };
  }
  throw new OpenCodeError("model must be a provider/model string.");
}

export function permissionDecision(input: unknown): "once" | "always" | "reject" {
  const value = typeof input === "string" ? input.trim().toLowerCase() : "";
  if (value === "approve" || value === "once" || value === "allow") return "once";
  if (value === "always") return "always";
  if (value === "deny" || value === "reject") return "reject";
  throw new OpenCodeError("decision must be approve, once, always, deny, or reject.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function unwrapData(body: unknown): unknown {
  if (!isRecord(body) || !("data" in body)) return body;
  const keys = Object.keys(body);
  if (keys.every((key) => key === "data" || key === "location" || key === "cursor")) return body.data;
  return body;
}

export function pickDirectory(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of ["directory", "worktree", "canonical", "path"]) {
    const found = value[key];
    if (typeof found === "string" && found.trim() !== "") return found;
  }
  if (value.location) {
    const nested = pickDirectory(value.location);
    if (nested) return nested;
  }
  if (value.project) {
    const nested = pickDirectory(value.project);
    if (nested) return nested;
  }
  return undefined;
}

function pickString(value: unknown, keys: string[]): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of keys) {
    const found = value[key];
    if (typeof found === "string" && found.trim() !== "") return found;
  }
  return undefined;
}

function textFromParts(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  const chunks: string[] = [];
  for (const part of parts) {
    if (!isRecord(part)) continue;
    if (typeof part.text === "string") chunks.push(part.text);
    else if (typeof part.content === "string") chunks.push(part.content);
    else if (part.type === "tool" || part.type === "tool-invocation" || part.type === "tool-call") {
      const name = pickString(part, ["tool", "name"]) ?? "tool";
      chunks.push(`[${name}]`);
    }
  }
  return chunks.join("\n").trim();
}

export function toMessageView(raw: unknown): MessageView {
  if (!isRecord(raw)) return { text: "", raw };
  const info = isRecord(raw.info) ? raw.info : raw;
  const id = pickString(info, ["id", "messageID"]);
  const role = pickString(info, ["role", "type"]);
  let text = "";
  if (typeof raw.text === "string") text = raw.text;
  else if (typeof info.text === "string") text = info.text;
  else text = textFromParts(raw.parts ?? info.parts);
  if (!text && typeof raw.content === "string") text = raw.content;
  return {
    ...(id ? { id } : {}),
    ...(role ? { role } : {}),
    text,
    raw,
  };
}

function toSessionSummary(raw: unknown): SessionSummary | undefined {
  if (!isRecord(raw)) return undefined;
  const id = pickString(raw, ["id", "sessionID"]);
  if (!id) return undefined;
  const directory = pickDirectory(raw);
  const title = pickString(raw, ["title", "name"]);
  const parentId = pickString(raw, ["parentID", "parentId"]);
  return {
    id,
    ...(title ? { title } : {}),
    ...(directory ? { directory } : {}),
    ...(parentId ? { parentId } : {}),
    raw,
  };
}

function asArray(body: unknown): unknown[] {
  const data = unwrapData(body);
  if (Array.isArray(data)) return data;
  if (Array.isArray(body)) return body;
  if (isRecord(data) && Array.isArray(data.items)) return data.items;
  if (isRecord(body) && Array.isArray(body.items)) return body.items;
  return [];
}

export function sessionIsActive(activeBody: unknown, sessionId: string): boolean {
  const data = unwrapData(activeBody);
  if (Array.isArray(data)) {
    return data.some((item) => {
      if (typeof item === "string") return item === sessionId;
      if (!isRecord(item)) return false;
      return item.id === sessionId || item.sessionID === sessionId;
    });
  }
  if (isRecord(data)) {
    if (sessionId in data) return true;
    for (const key of ["sessions", "active", "items"]) {
      if (key in data && sessionIsActive(data[key], sessionId)) return true;
    }
  }
  return false;
}

function activityFromV1Status(statusBody: unknown, sessionId: string): SessionView["activity"] {
  const data = unwrapData(statusBody);
  if (!isRecord(data) || !(sessionId in data)) return "idle";
  const entry = data[sessionId];
  if (!isRecord(entry)) return "busy";
  if (entry.type === "idle") return "idle";
  if (entry.type === "retry") return "retry";
  if (entry.type === "busy") return "busy";
  return "busy";
}

function toPermission(raw: unknown): PermissionView | undefined {
  if (!isRecord(raw)) return undefined;
  const id = pickString(raw, ["id", "requestID", "permissionID"]);
  if (!id) return undefined;
  const sessionId = pickString(raw, ["sessionID", "sessionId"]);
  const action = pickString(raw, ["action", "permission", "type"]);
  let resources: string[] | undefined;
  if (Array.isArray(raw.resources)) resources = raw.resources.filter((item) => typeof item === "string") as string[];
  else if (Array.isArray(raw.patterns)) resources = raw.patterns.filter((item) => typeof item === "string") as string[];
  return {
    id,
    ...(sessionId ? { sessionId } : {}),
    ...(action ? { action } : {}),
    ...(resources ? { resources } : {}),
    raw,
  };
}

function toDiff(raw: unknown): DiffView {
  if (!isRecord(raw)) return { raw };
  const file = pickString(raw, ["file", "path", "filename"]);
  const patch = pickString(raw, ["patch", "diff", "text"]);
  const status = pickString(raw, ["status"]);
  return {
    ...(file ? { file } : {}),
    ...(typeof raw.additions === "number" ? { additions: raw.additions } : {}),
    ...(typeof raw.deletions === "number" ? { deletions: raw.deletions } : {}),
    ...(patch ? { patch } : {}),
    ...(status ? { status } : {}),
    raw,
  };
}

function toNamed(raw: unknown, fallbackProvider?: string): NamedInfo | undefined {
  if (typeof raw === "string") return { id: raw, raw };
  if (!isRecord(raw)) return undefined;
  const id = pickString(raw, ["id", "name", "modelID"]);
  if (!id) return undefined;
  const name = pickString(raw, ["name", "title"]);
  const providerId = pickString(raw, ["providerID", "providerId"]) ?? fallbackProvider;
  return {
    id,
    ...(name ? { name } : {}),
    ...(providerId ? { providerId } : {}),
    raw,
  };
}

function flattenModels(body: unknown): NamedInfo[] {
  const data = unwrapData(body);
  const out: NamedInfo[] = [];
  const push = (value: unknown, provider?: string) => {
    const named = toNamed(value, provider);
    if (named) out.push(named);
  };
  if (Array.isArray(data)) {
    for (const item of data) push(item);
    return out;
  }
  if (!isRecord(data)) return out;
  if (Array.isArray(data.all)) {
    for (const provider of data.all) {
      if (!isRecord(provider)) continue;
      const providerId = pickString(provider, ["id", "providerID"]);
      const models = provider.models;
      if (Array.isArray(models)) {
        for (const model of models) push(model, providerId);
      } else if (isRecord(models)) {
        for (const [id, model] of Object.entries(models)) {
          if (isRecord(model)) push({ id, ...model }, providerId);
          else push(id, providerId);
        }
      }
    }
  }
  if (Array.isArray(data.providers)) {
    for (const provider of data.providers) {
      if (!isRecord(provider)) continue;
      const providerId = pickString(provider, ["id", "providerID"]);
      const models = provider.models;
      if (Array.isArray(models)) for (const model of models) push(model, providerId);
      else if (isRecord(models)) {
        for (const [id, model] of Object.entries(models)) {
          if (isRecord(model)) push({ id, ...model }, providerId);
          else push({ id }, providerId);
        }
      }
    }
  }
  return out;
}

function toForm(raw: unknown): FormView | undefined {
  if (!isRecord(raw)) return undefined;
  const id = pickString(raw, ["id", "requestID"]);
  if (!id) return undefined;
  const sessionId = pickString(raw, ["sessionID", "sessionId"]);
  const title = pickString(raw, ["title", "question", "prompt"]);
  return {
    id,
    ...(sessionId ? { sessionId } : {}),
    ...(title ? { title } : {}),
    raw,
  };
}

function looksLikeHtml(contentType: string, text: string): boolean {
  if (contentType.includes("text/html")) return true;
  const trimmed = text.trimStart().slice(0, 32).toLowerCase();
  return trimmed.startsWith("<!doctype") || trimmed.startsWith("<html") || trimmed.startsWith("<head");
}

export interface OpenCodeClientOptions {
  baseUrl: string;
  auth?: OpenCodeAuth;
  fetch?: FetchLike;
  timeoutMs?: number;
}

interface HttpResult {
  status: number;
  body: unknown;
  text: string;
  contentType: string;
}

export class OpenCodeClient {
  readonly baseUrl: string;
  readonly api: ApiGeneration;
  readonly auth: OpenCodeAuth;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  version?: string;

  constructor(options: OpenCodeClientOptions & { api: ApiGeneration; version?: string }) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.api = options.api;
    this.auth = options.auth ?? { username: "opencode" };
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.version = options.version;
  }

  private async request(
    method: string,
    path: string,
    opts: { query?: Record<string, string | undefined>; body?: unknown; directory?: string; timeoutMs?: number } = {},
  ): Promise<HttpResult> {
    const url = new URL(path, `${this.baseUrl}/`);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value != null && value !== "") url.searchParams.set(key, value);
    }
    if (opts.directory && (method === "GET" || method === "HEAD")) {
      url.searchParams.set("directory", opts.directory);
      if (this.api === "v2") url.searchParams.set("location[directory]", opts.directory);
    }
    const headers = new Headers();
    headers.set("accept", "application/json");
    if (this.auth.password) headers.set("authorization", basicAuthHeader(this.auth.username || "opencode", this.auth.password));
    if (opts.directory) headers.set("x-opencode-directory", encodeURIComponent(opts.directory));
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(opts.body);
    }
    const timeout = opts.timeoutMs ?? this.timeoutMs;
    const response = await this.fetchImpl(url.toString(), {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(timeout),
    });
    const text = await response.text();
    const contentType = response.headers.get("content-type") ?? "";
    if (looksLikeHtml(contentType, text)) {
      throw new OpenCodeError(HTML_ERROR, response.status);
    }
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (response.status === 401) {
      throw new OpenCodeError(
        "OpenCode rejected credentials (HTTP 401). Set OPENCODE_PASSWORD to the server password. The username is opencode.",
        401,
        parsed,
      );
    }
    if (response.status >= 400) {
      throw new OpenCodeError(formatError(response.status, parsed, text), response.status, parsed);
    }
    return { status: response.status, body: parsed, text, contentType };
  }

  async serverInfo(): Promise<ServerInfo> {
    if (this.api === "v2") {
      const res = await this.request("GET", "/api/info");
      const raw = res.body;
      const version = isRecord(raw) && typeof raw.version === "string" ? raw.version : this.version;
      return { api: "v2", healthy: true, ...(version ? { version } : {}), raw };
    }
    const res = await this.request("GET", "/global/health");
    const raw = res.body;
    const version = isRecord(raw) && typeof raw.version === "string" ? raw.version : this.version;
    const healthy = isRecord(raw) ? raw.healthy !== false : true;
    return { api: "v1", healthy, ...(version ? { version } : {}), raw };
  }

  async listProjects(): Promise<ProjectInfo[]> {
    const res = await this.request("GET", this.api === "v2" ? "/api/project" : "/project");
    return asArray(res.body).map((raw) => {
      const directory = pickDirectory(raw);
      return {
        ...(pickString(raw, ["id"]) ? { id: pickString(raw, ["id"]) } : {}),
        ...(pickString(raw, ["name", "title"]) ? { name: pickString(raw, ["name", "title"]) } : {}),
        ...(directory ? { directory } : {}),
        raw,
      };
    });
  }

  async listSessions(opts: { directory?: string; limit?: number; search?: string } = {}): Promise<SessionSummary[]> {
    const query: Record<string, string | undefined> = {};
    if (opts.limit) query.limit = String(opts.limit);
    if (opts.search) query.search = opts.search;
    const res = await this.request("GET", this.api === "v2" ? "/api/session" : "/session", {
      query,
      directory: opts.directory,
    });
    return asArray(res.body).map(toSessionSummary).filter((item): item is SessionSummary => !!item);
  }

  async startSession(input: {
    directory: string;
    title?: string;
    agent?: string;
    model?: unknown;
  }): Promise<SessionSummary> {
    const model = parseModel(input.model);
    if (this.api === "v2") {
      const res = await this.request("POST", "/api/session", {
        body: {
          ...(input.title ? { title: input.title } : {}),
          ...(input.agent ? { agent: input.agent } : {}),
          ...(model ? { model } : {}),
          location: { directory: input.directory },
        },
      });
      const summary = toSessionSummary(unwrapData(res.body));
      if (!summary) throw new OpenCodeError("OpenCode created a session without an id.");
      return summary;
    }
    const res = await this.request("POST", "/session", {
      directory: input.directory,
      body: {
        ...(input.title ? { title: input.title } : {}),
        ...(input.agent ? { agent: input.agent } : {}),
        ...(model ? { model: { providerID: model.providerID, modelID: model.id } } : {}),
      },
    });
    const summary = toSessionSummary(unwrapData(res.body) ?? res.body);
    if (!summary) throw new OpenCodeError("OpenCode created a session without an id.");
    return { ...summary, directory: summary.directory ?? input.directory };
  }

  async sendPrompt(input: {
    sessionId: string;
    text: string;
    agent?: string;
    model?: unknown;
  }): Promise<PromptAccepted> {
    const sessionId = assertId(input.sessionId, "sessionId");
    const model = parseModel(input.model);
    if (this.api === "v2") {
      if (input.agent) {
        await this.request("POST", `/api/session/${encodeURIComponent(sessionId)}/agent`, {
          body: { agent: input.agent },
        });
      }
      if (model) {
        await this.request("POST", `/api/session/${encodeURIComponent(sessionId)}/model`, {
          body: { model },
        });
      }
      const res = await this.request("POST", `/api/session/${encodeURIComponent(sessionId)}/prompt`, {
        body: { text: input.text, resume: true },
      });
      const data = unwrapData(res.body);
      const messageId = pickString(data, ["id", "messageID"]);
      return { sessionId, ...(messageId ? { messageId } : {}), accepted: true, raw: res.body };
    }
    const res = await this.request("POST", `/session/${encodeURIComponent(sessionId)}/prompt_async`, {
      body: {
        parts: [{ type: "text", text: input.text }],
        ...(input.agent ? { agent: input.agent } : {}),
        ...(model ? { model: { providerID: model.providerID, modelID: model.id } } : {}),
      },
    });
    return { sessionId, accepted: true, raw: res.body ?? { status: res.status } };
  }

  async getMessages(sessionId: string, limit?: number): Promise<MessageView[]> {
    const id = assertId(sessionId, "sessionId");
    const query: Record<string, string | undefined> = { order: "asc" };
    if (limit) query.limit = String(limit);
    const res = await this.request(
      "GET",
      this.api === "v2" ? `/api/session/${encodeURIComponent(id)}/message` : `/session/${encodeURIComponent(id)}/message`,
      { query },
    );
    return asArray(res.body).map(toMessageView);
  }

  async getSession(sessionId: string): Promise<SessionView> {
    const id = assertId(sessionId, "sessionId");
    if (this.api === "v2") {
      const [sessionRes, activeRes] = await Promise.all([
        this.request("GET", `/api/session/${encodeURIComponent(id)}`),
        this.request("GET", "/api/session/active"),
      ]);
      const raw = unwrapData(sessionRes.body);
      const directory = pickDirectory(raw);
      const title = pickString(raw, ["title", "name"]);
      const active = sessionIsActive(activeRes.body, id);
      return {
        id,
        ...(title ? { title } : {}),
        ...(directory ? { directory } : {}),
        activity: active ? "busy" : "idle",
        raw,
        status: unwrapData(activeRes.body),
      };
    }
    const [sessionRes, statusRes] = await Promise.all([
      this.request("GET", `/session/${encodeURIComponent(id)}`),
      this.request("GET", "/session/status"),
    ]);
    const raw = unwrapData(sessionRes.body);
    const directory = pickDirectory(raw);
    const title = pickString(raw, ["title", "name"]);
    return {
      id,
      ...(title ? { title } : {}),
      ...(directory ? { directory } : {}),
      activity: activityFromV1Status(statusRes.body, id),
      raw,
      status: statusRes.body,
    };
  }

  async getDiff(sessionId: string, messageId?: string): Promise<DiffView[]> {
    const id = assertId(sessionId, "sessionId");
    if (messageId) assertId(messageId, "messageId");
    const res =
      this.api === "v2"
        ? await this.request("GET", `/api/session/${encodeURIComponent(id)}/diff`, {
            query: { from: messageId },
          })
        : await this.request("GET", `/session/${encodeURIComponent(id)}/diff`, {
            query: { messageID: messageId },
          });
    return asArray(res.body).map(toDiff);
  }

  async listPermissions(opts: { sessionId?: string; directory?: string } = {}): Promise<PermissionView[]> {
    if (opts.sessionId) assertId(opts.sessionId, "sessionId");
    let body: unknown;
    if (this.api === "v2") {
      const path = opts.sessionId
        ? `/api/session/${encodeURIComponent(opts.sessionId)}/permission`
        : "/api/permission/request";
      const res = await this.request("GET", path, { directory: opts.sessionId ? undefined : opts.directory });
      body = res.body;
    } else {
      const res = await this.request("GET", "/permission", { directory: opts.directory });
      body = res.body;
    }
    let items = asArray(body).map(toPermission).filter((item): item is PermissionView => !!item);
    if (opts.sessionId) items = items.filter((item) => !item.sessionId || item.sessionId === opts.sessionId);
    return items;
  }

  async respondPermission(input: {
    sessionId: string;
    requestId: string;
    decision: unknown;
    message?: string;
  }): Promise<{ replied: true; decision: "once" | "always" | "reject" }> {
    const sessionId = assertId(input.sessionId, "sessionId");
    const requestId = assertId(input.requestId, "requestId");
    const decision = permissionDecision(input.decision);
    if (this.api === "v2") {
      await this.request(
        "POST",
        `/api/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(requestId)}/reply`,
        { body: { decision, message: input.message ?? null } },
      );
      return { replied: true, decision };
    }
    const primary = await this.request(
      "POST",
      `/session/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(requestId)}`,
      {
        body: { response: decision, remember: decision === "always" },
      },
    ).then(
      () => true,
      async (err: unknown) => {
        if (err instanceof OpenCodeError && err.status === 404) return false;
        throw err;
      },
    );
    if (!primary) {
      await this.request("POST", `/permission/${encodeURIComponent(requestId)}/reply`, {
        body: { reply: decision, ...(input.message ? { message: input.message } : {}) },
      });
    }
    return { replied: true, decision };
  }

  async abort(sessionId: string): Promise<{ aborted: true; raw: unknown }> {
    const id = assertId(sessionId, "sessionId");
    const res =
      this.api === "v2"
        ? await this.request("POST", `/api/session/${encodeURIComponent(id)}/interrupt`)
        : await this.request("POST", `/session/${encodeURIComponent(id)}/abort`);
    return { aborted: true, raw: res.body };
  }

  async listAgents(directory?: string): Promise<NamedInfo[]> {
    const res = await this.request("GET", this.api === "v2" ? "/api/agent" : "/agent", { directory });
    return asArray(res.body).map((item) => toNamed(item)).filter((item): item is NamedInfo => !!item);
  }

  async listModels(directory?: string): Promise<NamedInfo[]> {
    if (this.api === "v2") {
      const res = await this.request("GET", "/api/model", { directory });
      const models = flattenModels(res.body);
      if (models.length > 0) return models;
      return asArray(res.body).map((item) => toNamed(item)).filter((item): item is NamedInfo => !!item);
    }
    const res = await this.request("GET", "/provider", { directory });
    const models = flattenModels(res.body);
    if (models.length > 0) return models;
    const config = await this.request("GET", "/config/providers", { directory });
    return flattenModels(config.body);
  }

  async runCommand(input: { sessionId: string; command: string; arguments?: string; agent?: string }): Promise<{ ran: true; raw: unknown }> {
    const sessionId = assertId(input.sessionId, "sessionId");
    const command = input.command.trim().replace(/^\//, "");
    if (!command) throw new OpenCodeError("command is required.");
    if (this.api === "v2") {
      const res = await this.request("POST", `/api/session/${encodeURIComponent(sessionId)}/command`, {
        body: { name: command, text: input.arguments ?? "" },
      });
      return { ran: true, raw: res.body };
    }
    const res = await this.request("POST", `/session/${encodeURIComponent(sessionId)}/command`, {
      body: {
        command,
        arguments: input.arguments ?? "",
        ...(input.agent ? { agent: input.agent } : {}),
      },
    });
    return { ran: true, raw: res.body };
  }

  async listForms(opts: { sessionId?: string; directory?: string } = {}): Promise<FormView[]> {
    if (opts.sessionId) assertId(opts.sessionId, "sessionId");
    if (this.api === "v2") {
      const path = opts.sessionId ? `/api/session/${encodeURIComponent(opts.sessionId)}/form` : "/api/form";
      const res = await this.request("GET", path, { directory: opts.sessionId ? undefined : opts.directory });
      return asArray(res.body).map(toForm).filter((item): item is FormView => !!item);
    }
    const res = await this.request("GET", "/question", { directory: opts.directory });
    let items = asArray(res.body).map(toForm).filter((item): item is FormView => !!item);
    if (opts.sessionId) items = items.filter((item) => !item.sessionId || item.sessionId === opts.sessionId);
    return items;
  }

  async replyForm(input: { sessionId: string; formId: string; answer: unknown }): Promise<{ replied: true }> {
    const sessionId = assertId(input.sessionId, "sessionId");
    const formId = assertId(input.formId, "formId");
    if (this.api === "v2") {
      await this.request("POST", `/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(formId)}/reply`, {
        body: { answer: input.answer },
      });
      return { replied: true };
    }
    const answer = isRecord(input.answer) && "answers" in input.answer ? input.answer : { answers: input.answer };
    await this.request("POST", `/question/${encodeURIComponent(formId)}/reply`, { body: answer });
    return { replied: true };
  }

  async deleteSession(sessionId: string): Promise<{ deleted: true }> {
    const id = assertId(sessionId, "sessionId");
    await this.request("DELETE", this.api === "v2" ? `/api/session/${encodeURIComponent(id)}` : `/session/${encodeURIComponent(id)}`);
    return { deleted: true };
  }
}

function formatError(status: number, body: unknown, text: string): string {
  if (isRecord(body)) {
    const tag = typeof body._tag === "string" ? body._tag : undefined;
    const message = typeof body.message === "string" ? body.message : undefined;
    if (tag && message) return `OpenCode ${status} ${tag}: ${message}`;
    if (message) return `OpenCode ${status}: ${message}`;
    if (tag) return `OpenCode ${status} ${tag}`;
  }
  const snippet = text.replace(/\s+/g, " ").slice(0, 240);
  return `OpenCode ${status}${snippet ? `: ${snippet}` : ""}`;
}

export async function detectOpenCode(options: OpenCodeClientOptions): Promise<OpenCodeClient> {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  const probe = new OpenCodeClient({ ...options, baseUrl, fetch: fetchImpl, api: "v2" });
  try {
    const info = await probe.serverInfo();
    if (isRecord(info.raw) || info.raw == null) {
      return new OpenCodeClient({ ...options, baseUrl, fetch: fetchImpl, api: "v2", version: info.version });
    }
  } catch (err) {
    if (err instanceof OpenCodeError && err.status === 401) throw err;
    if (err instanceof OpenCodeError && err.message === HTML_ERROR) {
      /* fall through to v1 */
    } else if (err instanceof OpenCodeError && err.status && err.status !== 404) {
      throw err;
    }
  }
  const v1 = new OpenCodeClient({ ...options, baseUrl, fetch: fetchImpl, api: "v1" });
  try {
    const info = await v1.serverInfo();
    return new OpenCodeClient({ ...options, baseUrl, fetch: fetchImpl, api: "v1", version: info.version });
  } catch (err) {
    if (err instanceof OpenCodeError && err.status === 401) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new OpenCodeError(
      `Could not reach an OpenCode HTTP API at ${baseUrl}. Start \`opencode serve\` (v2 /api/info) or an older server (GET /global/health). ${message}`,
    );
  }
}

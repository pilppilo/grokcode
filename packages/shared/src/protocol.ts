import { ToolError } from "./errors.js";

export const PROTOCOL_VERSION = 1;

export const OPS = [
  "server_info",
  "list_projects",
  "list_sessions",
  "start_session",
  "send_prompt",
  "get_messages",
  "get_session",
  "get_diff",
  "list_pending_permissions",
  "respond_permission",
  "abort",
  "list_agents",
  "list_models",
  "run_command",
  "list_forms",
  "reply_form",
  "delete_session",
] as const;

export type OpName = (typeof OPS)[number];

export function isOpName(value: string): value is OpName {
  return (OPS as readonly string[]).includes(value);
}

export interface HelloMessage {
  type: "hello";
  protocol: number;
  opencode?: { api?: "v1" | "v2"; version?: string };
}

export interface WelcomeMessage {
  type: "welcome";
  protocol: number;
  name: string;
}

export interface PingMessage {
  type: "ping";
  t: number;
}

export interface PongMessage {
  type: "pong";
  t: number;
}

export interface RpcMessage {
  type: "rpc";
  id: string;
  op: OpName;
  params: unknown;
}

export interface ResultMessage {
  type: "result";
  id: string;
  ok: true;
  data: unknown;
}

export interface ErrorMessage {
  type: "result";
  id: string;
  ok: false;
  error: { code: string; message: string; status?: number };
}

export type AgentMessage =
  | HelloMessage
  | WelcomeMessage
  | PingMessage
  | PongMessage
  | RpcMessage
  | ResultMessage
  | ErrorMessage;

const MAX_FRAME = 2_000_000;

export function encodeMessage(message: AgentMessage): string {
  return JSON.stringify(message);
}

export function parseMessage(raw: string): AgentMessage {
  if (raw.length > MAX_FRAME) {
    throw new ToolError("Relay frame exceeds the size limit.", "frame_too_large");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ToolError("Relay frame is not JSON.", "bad_frame");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ToolError("Relay frame must be an object.", "bad_frame");
  }
  const type = (value as { type?: unknown }).type;
  if (type === "hello") {
    const protocol = (value as { protocol?: unknown }).protocol;
    if (protocol !== PROTOCOL_VERSION) {
      throw new ToolError(`Unsupported agent protocol ${String(protocol)}.`, "bad_protocol");
    }
    const opencode = (value as { opencode?: unknown }).opencode;
    return {
      type: "hello",
      protocol,
      ...(opencode && typeof opencode === "object" ? { opencode: opencode as HelloMessage["opencode"] } : {}),
    };
  }
  if (type === "welcome") {
    const name = (value as { name?: unknown }).name;
    const protocol = (value as { protocol?: unknown }).protocol;
    if (typeof name !== "string" || protocol !== PROTOCOL_VERSION) {
      throw new ToolError("Invalid welcome frame.", "bad_frame");
    }
    return { type: "welcome", protocol, name };
  }
  if (type === "ping" || type === "pong") {
    const t = (value as { t?: unknown }).t;
    if (typeof t !== "number") throw new ToolError("Invalid ping frame.", "bad_frame");
    return { type, t };
  }
  if (type === "rpc") {
    const id = (value as { id?: unknown }).id;
    const op = (value as { op?: unknown }).op;
    if (typeof id !== "string" || id.length === 0 || id.length > 80) {
      throw new ToolError("RPC id is missing.", "bad_frame");
    }
    if (typeof op !== "string" || !isOpName(op)) {
      throw new ToolError(`Unknown op ${String(op)}.`, "unknown_op");
    }
    return { type: "rpc", id, op, params: (value as { params?: unknown }).params ?? {} };
  }
  if (type === "result") {
    const id = (value as { id?: unknown }).id;
    const ok = (value as { ok?: unknown }).ok;
    if (typeof id !== "string" || typeof ok !== "boolean") {
      throw new ToolError("Invalid result frame.", "bad_frame");
    }
    if (ok) return { type: "result", id, ok: true, data: (value as { data?: unknown }).data };
    const error = (value as { error?: { code?: unknown; message?: unknown; status?: unknown } }).error;
    return {
      type: "result",
      id,
      ok: false,
      error: {
        code: typeof error?.code === "string" ? error.code : "error",
        message: typeof error?.message === "string" ? error.message : "Agent call failed.",
        ...(typeof error?.status === "number" ? { status: error.status } : {}),
      },
    };
  }
  throw new ToolError(`Unknown frame type ${String(type)}.`, "bad_frame");
}

export const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export function assertId(value: unknown, field: string): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new ToolError(`${field} must be a short id without path separators.`, "invalid_id");
  }
  return value;
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function requiredString(value: unknown, field: string, max = 200_000): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ToolError(`${field} is required.`, "invalid_argument");
  }
  if (value.length > max) {
    throw new ToolError(`${field} exceeds ${max} characters.`, "invalid_argument");
  }
  return value;
}

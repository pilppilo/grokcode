import { ToolError } from "./errors.js";

export const PROTOCOL_VERSION = 1;

export const OPS = [
  "server_info",
  "list_projects",
  "list_sessions",
  "start_session",
  "send_prompt",
  "get_messages",
  "get_message",
  "get_session",
  "get_session_summary",
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
  "opencode_status",
  "start_opencode",
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
  /**
   * Set together when `data` is one slice of a JSON string. The hub joins
   * every slice and parses the payload. A single frame leaves these unset.
   */
  part?: number;
  parts?: number;
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

/**
 * Stay under the 1 MiB Cloudflare WebSocket message limit. Larger results are
 * split by {@link encodeResultFrames} so the platform never drops them.
 */
export const MAX_FRAME = 900_000;

export function encodeResultFrames(id: string, data: unknown): string[] {
  const single = JSON.stringify({ type: "result", id, ok: true, data });
  if (single.length <= MAX_FRAME) return [single];
  const payload = JSON.stringify(data);
  const slices: string[] = [];
  let cursor = 0;
  while (cursor < payload.length) {
    let size = Math.min(payload.length - cursor, 250_000);
    while (size > 0) {
      const probe = JSON.stringify({
        type: "result",
        id,
        ok: true,
        part: slices.length,
        parts: 99_999,
        data: payload.slice(cursor, cursor + size),
      });
      if (probe.length <= MAX_FRAME) break;
      size = Math.floor(size * 0.75);
    }
    if (size <= 0) {
      throw new ToolError("Unable to fit a relay result into the frame limit.", "frame_too_large");
    }
    slices.push(payload.slice(cursor, cursor + size));
    cursor += size;
  }
  return slices.map((slice, index) =>
    JSON.stringify({
      type: "result",
      id,
      ok: true,
      part: index,
      parts: slices.length,
      data: slice,
    }),
  );
}

/** Join chunk `data` slices back into the original result value. */
export function parseChunkedResult(pieces: Array<string | undefined>): unknown {
  if (pieces.some((piece) => typeof piece !== "string")) {
    throw new ToolError("Incomplete relay result.", "bad_frame");
  }
  try {
    return JSON.parse(pieces.join(""));
  } catch {
    throw new ToolError("Relay result chunks did not form JSON.", "bad_frame");
  }
}

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
    if (ok) {
      const part = (value as { part?: unknown }).part;
      const parts = (value as { parts?: unknown }).parts;
      return {
        type: "result",
        id,
        ok: true,
        data: (value as { data?: unknown }).data,
        ...(typeof part === "number" ? { part } : {}),
        ...(typeof parts === "number" ? { parts } : {}),
      };
    }
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

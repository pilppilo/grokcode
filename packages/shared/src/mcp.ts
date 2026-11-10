import { errorCode, errorMessage, GrokcodeError, ToolError } from "./errors.js";
import type { MachineInfo } from "./hub.js";
import { TOOLS, toolByName } from "./tools.js";

export const SERVER_NAME = "grokcode";
export const SERVER_VERSION = "0.1.0";
export const DEFAULT_SYNC_WAIT_MS = 20_000;
export const MAX_SYNC_WAIT_MS = 25_000;
export const DEFAULT_POLL_MS = 750;
/** If a session never looks busy, still wait this long before treating it as already idle. */
export const IDLE_GRACE_MS = 2_000;

const SUPPORTED_PROTOCOLS = new Set(["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]);

export interface MachineBackend {
  mode: "relay" | "direct";
  listMachines(): Promise<MachineInfo[]>;
  call(machine: string, op: string, params: unknown, timeoutMs?: number): Promise<unknown>;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface McpHandlerOptions {
  backend: MachineBackend;
  maxSyncWaitMs?: number;
  pollMs?: number;
  clock?: Clock;
  instructions?: string;
  /**
   * Reject browser Origin values that are not this host or loopback.
   * Direct mode wants this (DNS rebinding). The public relay does not:
   * a remote connector may send its own Origin, and bearer auth is the gate.
   */
  checkOrigin?: boolean;
}

const DEFAULT_INSTRUCTIONS = [
  "grokcode drives OpenCode (anomalyco/opencode) on the owner's PCs.",
  "Call list_machines first. Pass machine on every later tool when more than one PC is online.",
  "start_session needs an absolute directory on that PC. send_prompt defaults to async because agent turns outlive MCP and Cloudflare timeouts.",
  "After an async prompt, poll get_session and get_messages, or call wait_session. wait=true on send_prompt only blocks up to about 20 seconds, then returns status running.",
  "If list_pending_permissions or a wait result says needs_permission, call respond_permission (approve/once, always, or deny/reject) before expecting more output.",
  "abort interrupts the current turn.",
].join(" ");

const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

interface JsonRpc {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...extra,
    },
  });
}

function rpcResult(id: unknown, result: unknown): unknown {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): unknown {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function toolResult(payload: unknown, isError = false): { content: { type: "text"; text: string }[]; isError: boolean } {
  const text = truncate(typeof payload === "string" ? payload : JSON.stringify(payload, null, 2));
  return { content: [{ type: "text", text }], isError };
}

const TEXT_LIMIT = 80_000;

function truncate(text: string): string {
  if (text.length <= TEXT_LIMIT) return text;
  return `${text.slice(0, TEXT_LIMIT)}\n… truncated ${text.length - TEXT_LIMIT} characters`;
}

function clampWait(requested: unknown, maxSyncWaitMs: number): number {
  const max = Math.min(Math.max(0, maxSyncWaitMs), MAX_SYNC_WAIT_MS);
  if (typeof requested !== "number" || !Number.isFinite(requested)) return Math.min(DEFAULT_SYNC_WAIT_MS, max);
  return Math.max(0, Math.min(requested, max));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function resolveMachine(backend: MachineBackend, requested: unknown): Promise<string> {
  const machines = await backend.listMachines();
  const online = machines.map((machine) => machine.name);
  if (typeof requested === "string" && requested.trim() !== "") {
    const name = requested.trim();
    if (!online.includes(name)) {
      throw new ToolError(
        `Machine "${name}" is not connected. Online: ${online.join(", ") || "(none)"}`,
        "machine_offline",
      );
    }
    return name;
  }
  if (backend.mode === "direct" && machines[0]) return machines[0].name;
  if (machines.length === 1) return machines[0]!.name;
  throw new ToolError(
    `machine is required. Online: ${online.join(", ") || "(none)"}`,
    "machine_required",
  );
}

function activityOf(sessionResult: unknown): string {
  if (!isRecord(sessionResult)) return "unknown";
  const session = isRecord(sessionResult.session) ? sessionResult.session : sessionResult;
  return typeof session.activity === "string" ? session.activity : "unknown";
}

function permissionCount(result: unknown): number {
  if (!isRecord(result) || !Array.isArray(result.permissions)) return 0;
  return result.permissions.length;
}

async function pollUntilSettled(
  backend: MachineBackend,
  machine: string,
  sessionId: string,
  budgetMs: number,
  pollMs: number,
  clock: Clock,
  admitted?: unknown,
): Promise<unknown> {
  const started = clock.now();
  const deadline = started + budgetMs;
  let sawBusy = false;
  let lastSession: unknown;
  while (true) {
    const now = clock.now();
    lastSession = await backend.call(machine, "get_session", { sessionId }, 15_000);
    const permissions = await backend.call(machine, "list_pending_permissions", { sessionId }, 15_000);
    if (permissionCount(permissions) > 0) {
      return {
        status: "needs_permission",
        sessionId,
        ...(admitted ? { admitted } : {}),
        session: lastSession,
        permissions,
      };
    }
    const activity = activityOf(lastSession);
    if (activity === "busy" || activity === "retry") sawBusy = true;
    const idleLongEnough = activity === "idle" && (sawBusy || clock.now() - started >= Math.min(IDLE_GRACE_MS, budgetMs));
    if (idleLongEnough || activity === "idle" && budgetMs === 0) {
      const messages = await backend.call(machine, "get_messages", { sessionId, limit: 50 }, 15_000);
      return {
        status: "idle",
        sessionId,
        ...(admitted ? { admitted } : {}),
        session: lastSession,
        messages,
      };
    }
    if (now >= deadline) break;
    const sleptFrom = clock.now();
    await clock.sleep(Math.min(pollMs, Math.max(0, deadline - sleptFrom)));
    if (clock.now() <= sleptFrom) break;
  }
  const messages = await backend.call(machine, "get_messages", { sessionId, limit: 30 }, 15_000);
  return {
    status: "running",
    timedOut: true,
    sessionId,
    ...(admitted ? { admitted } : {}),
    session: lastSession,
    messages,
    hint: "The sync budget ended before OpenCode went idle. Poll get_session and get_messages, or call wait_session again.",
  };
}

async function callTool(
  options: McpHandlerOptions,
  name: string,
  args: unknown,
): Promise<unknown> {
  const tool = toolByName(name);
  if (!tool) throw new ToolError(`Unknown tool ${name}.`, "unknown_tool");
  const record = isRecord(args) ? args : {};
  if (tool.name === "list_machines") {
    return { machines: await options.backend.listMachines() };
  }
  const machine = await resolveMachine(options.backend, record.machine);
  const params = { ...record };
  delete params.machine;
  delete params.wait;
  delete params.timeoutMs;
  const maxWait = options.maxSyncWaitMs ?? DEFAULT_SYNC_WAIT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const clock = options.clock ?? realClock;

  if (tool.name === "send_prompt") {
    const admitted = await options.backend.call(machine, "send_prompt", params, 20_000);
    if (record.wait !== true) return { status: "accepted", ...spreadAdmitted(admitted) };
    const sessionId = typeof record.sessionId === "string" ? record.sessionId : undefined;
    if (!sessionId) throw new ToolError("sessionId is required.", "invalid_argument");
    return pollUntilSettled(options.backend, machine, sessionId, clampWait(record.timeoutMs, maxWait), pollMs, clock, admitted);
  }
  if (tool.name === "wait_session") {
    const sessionId = typeof record.sessionId === "string" ? record.sessionId : undefined;
    if (!sessionId) throw new ToolError("sessionId is required.", "invalid_argument");
    return pollUntilSettled(
      options.backend,
      machine,
      sessionId,
      clampWait(record.timeoutMs, maxWait),
      pollMs,
      clock,
    );
  }
  return options.backend.call(machine, tool.op ?? tool.name, params, 20_000);
}

function spreadAdmitted(admitted: unknown): Record<string, unknown> {
  if (!isRecord(admitted)) return { admitted };
  return admitted;
}

function protocolVersion(requested: unknown): string {
  if (typeof requested === "string" && SUPPORTED_PROTOCOLS.has(requested)) return requested;
  return "2025-03-26";
}

function handleRpc(message: JsonRpc, options: McpHandlerOptions): Promise<unknown> | unknown {
  const id = message.id;
  const method = message.method;
  if (message.jsonrpc !== "2.0" || typeof method !== "string") {
    return rpcError(id, -32600, "Invalid Request");
  }
  const params = message.params;

  if (method === "initialize") {
    const requested = isRecord(params) ? params.protocolVersion : undefined;
    return rpcResult(id, {
      protocolVersion: protocolVersion(requested),
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: options.instructions ?? DEFAULT_INSTRUCTIONS,
    });
  }
  if (method === "ping") return rpcResult(id, {});
  if (method === "tools/list") {
    return rpcResult(id, {
      tools: TOOLS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    });
  }
  if (method === "tools/call") {
    const name = isRecord(params) && typeof params.name === "string" ? params.name : "";
    const args = isRecord(params) ? params.arguments ?? {} : {};
    return callTool(options, name, args).then(
      (data) => rpcResult(id, toolResult(data, false)),
      (err: unknown) =>
        rpcResult(
          id,
          toolResult(
            {
              error: errorCode(err),
              message: errorMessage(err),
              ...(err instanceof GrokcodeError && err.status ? { status: err.status } : {}),
            },
            true,
          ),
        ),
    );
  }
  if (method === "resources/list") return rpcResult(id, { resources: [] });
  if (method === "prompts/list") return rpcResult(id, { prompts: [] });
  return rpcError(id, -32601, `Method not found: ${method}`);
}

function originAllowed(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return false;
  }
  const host = request.headers.get("host");
  if (host && originUrl.host === host) return true;
  const loopback = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
  return loopback.has(originUrl.hostname);
}

export function sseKeepalive(): Response {
  let timer: ReturnType<typeof setInterval> | undefined;
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(": grokcode\n\n"));
      timer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          if (timer) clearInterval(timer);
        }
      }, 15_000);
    },
    cancel() {
      if (timer) clearInterval(timer);
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}

/**
 * Streamable HTTP MCP endpoint. JSON responses are used for POST so a remote
 * client can call tools with a single request. GET opens a keepalive SSE stream
 * for clients that listen for server messages. Sessions are not required, so a
 * connector that only stores a URL and an Authorization header still works.
 */
export async function handleMcpRequest(request: Request, options: McpHandlerOptions): Promise<Response> {
  if (options.checkOrigin !== false && !originAllowed(request)) {
    return json({ error: "origin not allowed" }, 403);
  }
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(request),
    });
  }
  if (request.method === "GET") return withCors(request, sseKeepalive());
  if (request.method === "DELETE") return withCors(request, new Response(null, { status: 204 }));
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);

  const accept = request.headers.get("accept");
  if (accept && !accept.includes("application/json") && !accept.includes("text/event-stream") && !accept.includes("*/*")) {
    return json({ error: "Accept must include application/json or text/event-stream" }, 406);
  }
  const versionHeader = request.headers.get("mcp-protocol-version");
  if (versionHeader && !/^\d{4}-\d{2}-\d{2}$/.test(versionHeader)) {
    return json({ error: "bad MCP-Protocol-Version header" }, 400);
  }

  const text = await request.text();
  if (text.length > 1_000_000) return json(rpcError(null, -32600, "Request entity too large"), 413);

  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    return withCors(request, json(rpcError(null, -32700, "Parse error")));
  }

  const messages = Array.isArray(payload) ? payload : [payload];
  if (messages.length === 0 || messages.some((item) => !isRecord(item))) {
    return withCors(request, json(rpcError(null, -32600, "Invalid Request")));
  }

  const responses: unknown[] = [];
  for (const message of messages) {
    if (!("id" in message) || message.id === undefined) {
      continue;
    }
    responses.push(await handleRpc(message as JsonRpc, options));
  }
  if (responses.length === 0) {
    return withCors(request, new Response(null, { status: 202 }));
  }
  const body = Array.isArray(payload) ? responses : responses[0];
  return withCors(request, json(body));
}

function corsHeaders(request: Request): Headers {
  const headers = new Headers();
  const origin = request.headers.get("origin");
  headers.set("access-control-allow-origin", origin ?? "*");
  headers.set("access-control-allow-headers", "authorization, content-type, accept, mcp-session-id, mcp-protocol-version");
  headers.set("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
  headers.set("vary", "Origin");
  return headers;
}

function withCors(request: Request, response: Response): Response {
  const headers = corsHeaders(request);
  for (const [key, value] of response.headers) headers.set(key, value);
  return new Response(response.body, { status: response.status, headers });
}

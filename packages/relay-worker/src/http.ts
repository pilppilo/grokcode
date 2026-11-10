import {
  DEFAULT_SYNC_WAIT_MS,
  MAX_SYNC_WAIT_MS,
  MIN_TOKEN_LENGTH,
  bearerToken,
  clientAuthorized,
  handleMcpRequest,
  type MachineBackend,
  type MachineInfo,
} from "grokcode-shared";

export interface HubBridge {
  listMachines(): Promise<MachineInfo[]>;
  call(machine: string, op: string, params: unknown, timeoutMs?: number): Promise<unknown>;
}

export interface RelayHttpOptions {
  mcpToken?: string;
  bridge: HubBridge;
  maxSyncWaitMs?: number;
}

function clamp(value: string | number | undefined): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_SYNC_WAIT_MS;
  return Math.min(Math.max(0, parsed), MAX_SYNC_WAIT_MS);
}

/**
 * HTTP surface of the relay, minus the agent WebSocket (that is forwarded to
 * the Durable Object, which checks the per-machine token again).
 */
export async function handleRelayRequest(request: Request, options: RelayHttpOptions): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health" || (url.pathname === "/" && request.method === "GET")) {
    return Response.json({ ok: true, service: "grokcode-relay" });
  }
  if (url.pathname !== "/mcp") {
    return new Response("not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  if (request.method === "OPTIONS") {
    return handleMcpRequest(request, {
      backend: { mode: "relay", listMachines: async () => [], call: async () => ({}) },
      checkOrigin: false,
    });
  }
  if (!options.mcpToken || options.mcpToken.length < MIN_TOKEN_LENGTH) {
    return new Response("MCP_TOKEN is not configured\n", { status: 500 });
  }
  if (!clientAuthorized(options.mcpToken, bearerToken(request.headers.get("authorization")))) {
    return new Response("unauthorized\n", {
      status: 401,
      headers: { "www-authenticate": "Bearer" },
    });
  }
  const backend: MachineBackend = {
    mode: "relay",
    listMachines: () => options.bridge.listMachines(),
    call: (machine, op, params, timeoutMs) => options.bridge.call(machine, op, params, timeoutMs),
  };
  return handleMcpRequest(request, {
    backend,
    maxSyncWaitMs: clamp(options.maxSyncWaitMs),
    checkOrigin: false,
  });
}

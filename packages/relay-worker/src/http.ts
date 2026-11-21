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
import {
  SHELL_INSTRUCTIONS,
  SHELL_SERVER_NAME,
  SHELL_SERVER_VERSION,
  SHELL_TOOLS,
  callShellTool,
} from "grokcode-shell/remote";

import {
  GEMINI_MCP_PATH,
  accessTokenSubject,
  handleOAuthRequest,
  isOAuthPath,
  wwwAuthenticate,
  type OAuthConfig,
} from "./oauth.js";

export interface HubBridge {
  listMachines(): Promise<MachineInfo[]>;
  call(machine: string, op: string, params: unknown, timeoutMs?: number): Promise<unknown>;
}

export interface RelayHttpOptions {
  mcpToken?: string;
  bridge: HubBridge;
  maxSyncWaitMs?: number;
  /**
   * OAuth 2.1 for the Gemini shell endpoint. Absent in tests that only cover
   * the original bearer `/mcp` route. Static bearer auth keeps working either way.
   */
  oauth?: OAuthConfig;
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
  if (options.oauth && isOAuthPath(url.pathname)) {
    return handleOAuthRequest(request, options.oauth);
  }
  if (url.pathname === GEMINI_MCP_PATH) {
    return handleGemini(request, options);
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

async function handleGemini(request: Request, options: RelayHttpOptions): Promise<Response> {
  const origin = options.oauth?.publicOrigin || new URL(request.url).origin;
  if (request.method === "OPTIONS") {
    return handleMcpRequest(request, geminiMcpOptions(options));
  }
  const presented = bearerToken(request.headers.get("authorization"));
  const staticOk = clientAuthorized(options.mcpToken, presented);
  let oauthOk = false;
  if (!staticOk && presented && options.oauth) {
    oauthOk = (await accessTokenSubject(presented, options.oauth, request)) != null;
  }
  if (!staticOk && !oauthOk) {
    const error = presented ? "invalid_token" : "invalid_request";
    return new Response("unauthorized\n", {
      status: 401,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "www-authenticate": wwwAuthenticate(origin, error),
        "access-control-expose-headers": "WWW-Authenticate",
        "cache-control": "no-store",
      },
    });
  }
  return handleMcpRequest(request, geminiMcpOptions(options));
}

function geminiMcpOptions(options: RelayHttpOptions) {
  const backend: MachineBackend = {
    mode: "relay",
    listMachines: () => options.bridge.listMachines(),
    call: (machine, op, params, timeoutMs) => options.bridge.call(machine, op, params, timeoutMs),
  };
  return {
    backend,
    maxSyncWaitMs: clamp(options.maxSyncWaitMs),
    checkOrigin: false,
    tools: SHELL_TOOLS,
    callTool: (name: string, args: unknown) => callShellTool(backend, name, args, { maxSyncWaitMs: clamp(options.maxSyncWaitMs) }),
    serverName: SHELL_SERVER_NAME,
    serverVersion: SHELL_SERVER_VERSION,
    instructions: SHELL_INSTRUCTIONS,
  };
}

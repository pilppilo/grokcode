import { DurableObject } from "cloudflare:workers";

import {
  PROTOCOL_VERSION,
  RelayHub,
  bearerToken,
  encodeMessage,
  errorCode,
  errorMessage,
  machineAuthorized,
  parseMachineTokens,
  type SocketLike,
} from "grokcode-shared";

import type { Env } from "./env.js";

const adapters = new WeakMap<WebSocket, SocketLike>();

function adapt(ws: WebSocket): SocketLike {
  let socket = adapters.get(ws);
  if (!socket) {
    socket = {
      send: (data) => ws.send(data),
      close: (code, reason) => ws.close(code, reason ?? ""),
    };
    adapters.set(ws, socket);
  }
  return socket;
}

/**
 * One hub for every machine. WebSockets are hibernated by the platform;
 * in-flight RPC state lives only for the duration of a /call request.
 */
export class RelayHubDO extends DurableObject<Env> {
  private readonly hub = new RelayHub();
  private hydrated = false;

  private hydrate(): void {
    if (this.hydrated) return;
    this.hydrated = true;
    for (const ws of this.ctx.getWebSockets()) {
      const name = this.ctx.getTags(ws)[0];
      if (name) this.hub.attach(name, adapt(ws));
    }
  }

  async fetch(request: Request): Promise<Response> {
    this.hydrate();
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      return this.acceptAgent(request);
    }
    const url = new URL(request.url);
    if (url.pathname === "/machines" && request.method === "GET") {
      return Response.json({ machines: this.hub.list() });
    }
    if (url.pathname === "/call" && request.method === "POST") {
      const body = (await request.json()) as {
        machine?: string;
        op?: string;
        params?: unknown;
        timeoutMs?: number;
      };
      if (!body.machine || !body.op) {
        return Response.json({ ok: false, error: { code: "bad_request", message: "machine and op are required" } });
      }
      try {
        const data = await this.hub.call(body.machine, body.op, body.params ?? {}, body.timeoutMs);
        return Response.json({ ok: true, data });
      } catch (err) {
        return Response.json({
          ok: false,
          error: { code: errorCode(err), message: errorMessage(err) },
        });
      }
    }
    return new Response("not found", { status: 404 });
  }

  private acceptAgent(request: Request): Response {
    let tokens;
    try {
      tokens = parseMachineTokens(this.env.MACHINE_TOKENS);
    } catch (err) {
      const message = err instanceof Error ? err.message : "MACHINE_TOKENS is invalid";
      return new Response(message, { status: 500 });
    }
    const name = request.headers.get("x-grokcode-machine") ?? "";
    if (!machineAuthorized(tokens, name, bearerToken(request.headers.get("authorization")))) {
      return new Response("unauthorized", { status: 401 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [name]);
    const socket = adapt(server);
    this.hub.attach(name, socket);
    socket.send(encodeMessage({ type: "welcome", protocol: PROTOCOL_VERSION, name }));
    return new Response(null, { status: 101, webSocket: client });
  }

  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    this.hydrate();
    const name = this.ctx.getTags(ws)[0];
    if (!name) return;
    const text = typeof message === "string" ? message : new TextDecoder().decode(message);
    this.hub.handleSocketMessage(name, text);
  }

  override webSocketClose(ws: WebSocket): void {
    this.hydrate();
    const name = this.ctx.getTags(ws)[0];
    if (!name) return;
    this.hub.detach(name, adapt(ws));
  }

  override webSocketError(ws: WebSocket): void {
    this.webSocketClose(ws);
  }
}

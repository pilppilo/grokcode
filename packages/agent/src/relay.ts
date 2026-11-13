import WebSocket from "ws";

import {
  PROTOCOL_VERSION,
  encodeMessage,
  encodeResultFrames,
  errorCode,
  errorMessage,
  parseMessage,
  type AgentMessage,
} from "grokcode-shared";

export interface RelayConnectionOptions {
  url: string;
  name: string;
  token: string;
  execute: (op: string, params: unknown) => Promise<unknown>;
  signal: AbortSignal;
  opencode?: { api?: "v1" | "v2"; version?: string };
  /** Test hook. Defaults to the ws client. */
  connect?: (url: string, headers: Record<string, string>) => RelaySocket;
}

export interface RelaySocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "open" | "message" | "close" | "error", listener: (...args: never[]) => void): void;
  once(event: "open" | "error", listener: (...args: never[]) => void): void;
  readyState: number;
}

const OPEN = 1;

function defaultConnect(url: string, headers: Record<string, string>): RelaySocket {
  const ws = new WebSocket(url, { headers });
  return {
    send: (data) => ws.send(data),
    close: (code, reason) => ws.close(code, reason),
    on: (event, listener) => {
      ws.on(event, listener as never);
    },
    once: (event, listener) => {
      ws.once(event, listener as never);
    },
    get readyState() {
      return ws.readyState;
    },
  };
}

/** One relay session. Resolves when the socket closes so the caller can reconnect. */
export function runRelayConnection(options: RelayConnectionOptions): Promise<void> {
  const connect = options.connect ?? defaultConnect;
  const socket = connect(options.url, {
    Authorization: `Bearer ${options.token}`,
    "X-Grokcode-Machine": options.name,
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearInterval(ping);
      resolve();
    };
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      clearInterval(ping);
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    const ping = setInterval(() => {
      if (socket.readyState === OPEN) {
        socket.send(encodeMessage({ type: "ping", t: Date.now() }));
      }
    }, 20_000);

    const onAbort = () => {
      try {
        socket.close(1000, "shutdown");
      } catch {
        /* ignore */
      }
      finish();
    };
    if (options.signal.aborted) {
      onAbort();
      return;
    }
    options.signal.addEventListener("abort", onAbort, { once: true });

    socket.once("error", ((err: Error) => fail(err)) as never);
    socket.once("open", (() => {
      const hello: AgentMessage = {
        type: "hello",
        protocol: PROTOCOL_VERSION,
        ...(options.opencode ? { opencode: options.opencode } : {}),
      };
      socket.send(encodeMessage(hello));
    }) as never);

    socket.on("close", (() => finish()) as never);
    socket.on("message", (async (data: unknown) => {
      const text = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
      let message: AgentMessage;
      try {
        message = parseMessage(text);
      } catch (err) {
        socket.send(
          encodeMessage({
            type: "result",
            id: "0",
            ok: false,
            error: { code: errorCode(err), message: errorMessage(err) },
          }),
        );
        return;
      }
      if (message.type === "ping") {
        socket.send(encodeMessage({ type: "pong", t: message.t }));
        return;
      }
      if (message.type !== "rpc") return;
      try {
        const data = await options.execute(message.op, message.params);
        for (const frame of encodeResultFrames(message.id, data)) socket.send(frame);
      } catch (err) {
        socket.send(
          encodeMessage({
            type: "result",
            id: message.id,
            ok: false,
            error: {
              code: errorCode(err),
              message: errorMessage(err),
              ...(typeof (err as { status?: unknown }).status === "number"
                ? { status: (err as { status: number }).status }
                : {}),
            },
          }),
        );
      }
    }) as never);
  });
}

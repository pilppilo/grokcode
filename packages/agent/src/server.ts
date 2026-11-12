import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import {
  DEFAULT_SYNC_WAIT_MS,
  MAX_SYNC_WAIT_MS,
  bearerToken,
  clientAuthorized,
  detectPlatform,
  executeOp,
  handleMcpRequest,
  type MachineBackend,
  type OpenCodeClient,
  type PathPlatform,
} from "grokcode-shared";

export interface DirectServerOptions {
  host: string;
  port: number;
  name: string;
  mcpToken: string;
  allowDirs: readonly string[];
  home?: string;
  platform?: PathPlatform;
  maxSyncWaitMs?: number;
  getApi: () => Promise<OpenCodeClient>;
}

export interface ListeningServer {
  url: string;
  close: () => Promise<void>;
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("request too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function toRequest(req: IncomingMessage, host: string, port: number): Promise<Request> {
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req, 1_000_000);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value == null) continue;
    headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  const url = `http://${req.headers.host ?? `${host}:${port}`}${req.url ?? "/"}`;
  return new Request(url, {
    method: req.method,
    headers,
    ...(body && body.length > 0 ? { body } : {}),
  });
}

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    if (key === "transfer-encoding") return;
    headers[key] = value;
  });
  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  const abort = () => {
    void reader.cancel();
  };
  res.on("close", abort);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(value)) {
        await new Promise((resolve) => res.once("drain", resolve));
      }
    }
    res.end();
  } catch {
    res.destroy();
  } finally {
    res.off("close", abort);
  }
}

export function createDirectBackend(options: DirectServerOptions): MachineBackend {
  const started = Date.now();
  return {
    mode: "direct",
    async listMachines() {
      let api: "v1" | "v2" | undefined;
      let version: string | undefined;
      try {
        const client = await options.getApi();
        api = client.api;
        version = client.version;
      } catch {
        /* OpenCode may still be starting. The machine is listed anyway. */
      }
      return [{ name: options.name, connectedAt: started, ...(api ? { api } : {}), ...(version ? { version } : {}) }];
    },
    async call(machine, op, params) {
      if (machine !== options.name) {
        throw new Error(`This direct endpoint only serves ${options.name}.`);
      }
      const api = await options.getApi();
      return executeOp(
        {
          api,
          allowDirs: options.allowDirs,
          platform: options.platform ?? detectPlatform(),
          ...(options.home ? { home: options.home } : {}),
        },
        op,
        params,
      );
    },
  };
}

export async function handleDirectRequest(request: Request, options: DirectServerOptions): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health") {
    return Response.json({ ok: true, service: "grokcode-agent", machine: options.name });
  }
  if (url.pathname === "/" && request.method === "GET") {
    return new Response(
      "grokcode-agent direct MCP. POST JSON-RPC to /mcp with Authorization: Bearer <GROKCODE_MCP_TOKEN>.\n",
      { headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }
  if (url.pathname !== "/mcp") return new Response("not found\n", { status: 404 });
  if (request.method === "OPTIONS") {
    return handleMcpRequest(request, {
      backend: createDirectBackend(options),
      checkOrigin: true,
    });
  }
  if (!clientAuthorized(options.mcpToken, bearerToken(request.headers.get("authorization")))) {
    return new Response("unauthorized\n", {
      status: 401,
      headers: { "www-authenticate": "Bearer" },
    });
  }
  const maxSyncWaitMs = Math.min(options.maxSyncWaitMs ?? DEFAULT_SYNC_WAIT_MS, MAX_SYNC_WAIT_MS);
  return handleMcpRequest(request, {
    backend: createDirectBackend(options),
    maxSyncWaitMs,
    checkOrigin: true,
  });
}

export async function listenDirect(options: DirectServerOptions): Promise<ListeningServer> {
  const server = createServer(async (req, res) => {
    try {
      const request = await toRequest(req, options.host, options.port);
      const response = await handleDirectRequest(request, options);
      await writeResponse(res, response);
    } catch (err) {
      const message = err instanceof Error ? err.message : "bad request";
      if (!res.headersSent) res.writeHead(message === "request too large" ? 413 : 400);
      res.end(message);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  return {
    url: `http://${options.host}:${port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

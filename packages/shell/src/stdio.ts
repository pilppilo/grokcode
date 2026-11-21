import { handleMcpRequest, type MachineBackend } from "grokcode-shared";

import { callShellTool, SHELL_INSTRUCTIONS, SHELL_SERVER_NAME, SHELL_SERVER_VERSION, SHELL_TOOLS } from "./remote.js";
import type { ShellRuntime } from "./execute.js";

/** Encode one JSON-RPC message the way MCP stdio (LSP framing) expects. */
export function encodeFrame(payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8"), body]);
}

export function createFrameParser(onMessage: (value: unknown) => void, onError: (err: Error) => void): (chunk: Buffer) => void {
  let buf = Buffer.alloc(0);
  return (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    try {
      while (buf.length > 0) {
        if (buf[0] === 0x7b) {
          const nl = buf.indexOf(0x0a);
          if (nl < 0) return;
          const line = buf.subarray(0, nl).toString("utf8").replace(/\r$/, "");
          buf = buf.subarray(nl + 1);
          if (line.trim() === "") continue;
          onMessage(JSON.parse(line) as unknown);
          continue;
        }
        const sep = buf.indexOf("\r\n\r\n");
        if (sep < 0) {
          if (buf.length > 65_536) throw new Error("MCP header is too large.");
          return;
        }
        const header = buf.subarray(0, sep).toString("utf8");
        const match = /Content-Length:\s*(\d+)/i.exec(header);
        if (!match) throw new Error("MCP frame is missing Content-Length.");
        const len = Number(match[1]);
        if (!Number.isFinite(len) || len < 0 || len > 1_000_000) throw new Error("MCP frame length is invalid.");
        const start = sep + 4;
        if (buf.length < start + len) return;
        const body = buf.subarray(start, start + len).toString("utf8");
        buf = buf.subarray(start + len);
        onMessage(JSON.parse(body) as unknown);
      }
    } catch (err) {
      onError(err instanceof Error ? err : new Error(String(err)));
    }
  };
}

export function localBackend(name: string, runtime: ShellRuntime): MachineBackend {
  const started = Date.now();
  return {
    mode: "direct",
    async listMachines() {
      return [{ name, connectedAt: started }];
    },
    async call(machine, op, params) {
      if (machine !== name) {
        throw new Error(`This process only serves ${name}.`);
      }
      return runtime.execute(op, params);
    },
  };
}

export async function handleStdioMessage(message: unknown, backend: MachineBackend): Promise<unknown | undefined> {
  const request = new Request("http://127.0.0.1/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(message),
  });
  const response = await handleMcpRequest(request, {
    backend,
    tools: SHELL_TOOLS,
    callTool: (toolName, args) => callShellTool(backend, toolName, args),
    serverName: SHELL_SERVER_NAME,
    serverVersion: SHELL_SERVER_VERSION,
    instructions: SHELL_INSTRUCTIONS,
    checkOrigin: false,
  });
  if (response.status === 202 || response.status === 204) return undefined;
  const text = await response.text();
  if (!text) return undefined;
  return JSON.parse(text) as unknown;
}

import { handleMcpRequest, type MachineBackend } from "grokcode-shared";

import { callShellTool, SHELL_INSTRUCTIONS, SHELL_SERVER_NAME, SHELL_SERVER_VERSION, SHELL_TOOLS } from "./remote.js";
import type { ShellRuntime } from "./execute.js";

/** Encode one newline-delimited MCP stdio message. */
export function encodeFrame(payload: unknown): Buffer {
  return Buffer.from(JSON.stringify(payload) + "\n", "utf8");
}

export function createFrameParser(onMessage: (value: unknown) => void, onError: (err: Error) => void): (chunk: Buffer) => void {
  const maxLineBytes = 1_000_000;
  let pending = Buffer.alloc(0);
  let discarding = false;
  return (chunk) => {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(0x0a, start);
      const end = newline === -1 ? chunk.length : newline;
      const part = chunk.subarray(start, end);
      if (!discarding && pending.length + part.length > maxLineBytes) {
        pending = Buffer.alloc(0);
        discarding = true;
        onError(new Error("MCP stdio message is too large."));
      }
      if (!discarding) pending = Buffer.concat([pending, part]);
      if (newline === -1) return;
      const line = pending.toString("utf8").trim();
      pending = Buffer.alloc(0);
      discarding = false;
      start = end + 1;
      if (!line) continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch (err) {
        onError(err instanceof Error ? err : new Error(String(err)));
        continue;
      }
      onMessage(message);
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
    async call(machine, op, params, _timeoutMs, signal) {
      if (machine !== name) {
        throw new Error(`This process only serves ${name}.`);
      }
      return runtime.execute(op, params, signal);
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
    preserveToolResults: true,
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

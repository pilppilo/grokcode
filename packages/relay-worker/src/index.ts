import { HubError, errorCode, errorMessage, type MachineInfo } from "grokcode-shared";

import { RelayHubDO } from "./durable.js";
import type { Env } from "./env.js";
import { handleRelayRequest } from "./http.js";

export { RelayHubDO };

function stub(env: Env): DurableObjectStub {
  return env.HUB.get(env.HUB.idFromName("grokcode"));
}

async function bridgeCall(env: Env, machine: string, op: string, params: unknown, timeoutMs?: number): Promise<unknown> {
  const response = await stub(env).fetch("https://hub.internal/call", {
    method: "POST",
    body: JSON.stringify({ machine, op, params, timeoutMs }),
  });
  const body = (await response.json()) as {
    ok?: boolean;
    data?: unknown;
    error?: { code?: string; message?: string };
  };
  if (!body.ok) {
    throw new HubError(body.error?.message ?? "relay call failed", body.error?.code ?? "relay_error");
  }
  return body.data;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/agent") {
      try {
        return await stub(env).fetch(request);
      } catch (err) {
        return new Response(errorMessage(err), { status: 502, headers: { "x-grokcode-error": errorCode(err) } });
      }
    }
    try {
      const machines = async (): Promise<MachineInfo[]> => {
        const response = await stub(env).fetch("https://hub.internal/machines");
        const body = (await response.json()) as { machines?: MachineInfo[] };
        return body.machines ?? [];
      };
      return await handleRelayRequest(request, {
        mcpToken: env.MCP_TOKEN,
        maxSyncWaitMs: env.MAX_SYNC_WAIT_MS ? Number(env.MAX_SYNC_WAIT_MS) : undefined,
        bridge: {
          listMachines: machines,
          call: (machine, op, params, timeoutMs) => bridgeCall(env, machine, op, params, timeoutMs),
        },
      });
    } catch (err) {
      return new Response(errorMessage(err), { status: 502 });
    }
  },
};

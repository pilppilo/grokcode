import { HubError, errorCode, errorMessage, type MachineInfo } from "grokcode-shared";

import { RelayHubDO } from "./durable.js";
import type { Env } from "./env.js";
import { handleRelayRequest } from "./http.js";
import { GEMINI_MCP_PATH, isOAuthPath, parseOwnerEmails, parseStaticClients, type OAuthConfig, type OAuthStore } from "./oauth.js";
import { OAuthStoreDO } from "./oauth-do.js";

export { RelayHubDO, OAuthStoreDO };

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

function oauthStore(env: Env): OAuthStore {
  const id = env.OAUTH.idFromName("grokcode-oauth");
  const store = env.OAUTH.get(id);
  return {
    async get(key) {
      const response = await store.fetch("https://oauth.internal/get", { method: "POST", body: JSON.stringify({ key }) });
      const body = (await response.json()) as { value?: string | null };
      return body.value ?? null;
    },
    async put(key, value, expiresAt) {
      await store.fetch("https://oauth.internal/put", {
        method: "POST",
        body: JSON.stringify({ key, value, expiresAt: expiresAt ?? null }),
      });
    },
    async delete(key) {
      await store.fetch("https://oauth.internal/delete", { method: "POST", body: JSON.stringify({ key }) });
    },
  };
}

function oauthConfig(env: Env): OAuthConfig {
  return {
    store: oauthStore(env),
    ownerEmails: parseOwnerEmails(env.OWNER_EMAILS),
    ...(env.OWNER_APPROVAL_SECRET ? { approvalSecret: env.OWNER_APPROVAL_SECRET } : {}),
    ...(env.OAUTH_CLIENTS ? { staticClients: parseStaticClients(env.OAUTH_CLIENTS) } : {}),
    ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
      ? { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } }
      : {}),
    ...(env.PUBLIC_ORIGIN ? { publicOrigin: env.PUBLIC_ORIGIN } : {}),
  };
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
    let oauth: OAuthConfig | undefined;
    try {
      oauth = oauthConfig(env);
    } catch {
      if (isOAuthPath(url.pathname) || url.pathname.replace(/\/+$/, "") === GEMINI_MCP_PATH) {
        return new Response("OAuth configuration is invalid. Check OAUTH_CLIENTS.\n", { status: 500, headers: { "cache-control": "no-store" } });
      }
      oauth = undefined;
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
        ...(oauth ? { oauth } : {}),
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

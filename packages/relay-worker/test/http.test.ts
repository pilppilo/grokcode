import assert from "node:assert/strict";
import test from "node:test";

import { handleRelayRequest, type HubBridge } from "../src/http.ts";
import { MemoryOAuthStore, sha256, type OAuthConfig } from "../src/oauth.ts";

const MCP = "mcp-client-token-0123456789";

function bridge(partial: Partial<HubBridge> = {}): HubBridge & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    listMachines: partial.listMachines ?? (async () => [{ name: "laptop", connectedAt: 1, api: "v2" as const }]),
    call: partial.call ?? (async (machine, op, params) => {
      calls.push({ machine, op, params });
      return { api: "v2", healthy: true };
    }),
  };
}

function mcp(method: string, token?: string, body?: unknown, path = "/mcp") {
  return new Request(`https://relay.example${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

test("health is public and does not list machines", async () => {
  const response = await handleRelayRequest(new Request("https://relay.example/health"), {
    mcpToken: MCP,
    bridge: bridge(),
  });
  const body = (await response.json()) as { ok: boolean; machines?: unknown };
  assert.equal(body.ok, true);
  assert.equal(body.machines, undefined);
});

test("MCP rejects a missing token, a short server token, and a wrong client token", async () => {
  const missing = await handleRelayRequest(mcp("POST", undefined, { jsonrpc: "2.0", id: 1, method: "ping" }), {
    mcpToken: MCP,
    bridge: bridge(),
  });
  assert.equal(missing.status, 401);

  const unconfigured = await handleRelayRequest(mcp("POST", MCP, { jsonrpc: "2.0", id: 1, method: "ping" }), {
    mcpToken: "too-short",
    bridge: bridge(),
  });
  assert.equal(unconfigured.status, 500);
  assert.doesNotMatch(await unconfigured.text(), /too-short/);

  const wrong = await handleRelayRequest(
    mcp("POST", "not-the-mcp-token-at-all", { jsonrpc: "2.0", id: 1, method: "ping" }),
    { mcpToken: MCP, bridge: bridge() },
  );
  assert.equal(wrong.status, 401);
});

test("an authorized tools/call is proxied to the named machine", async () => {
  const hub = bridge();
  const response = await handleRelayRequest(
    mcp("POST", MCP, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "server_info", arguments: { machine: "laptop" } },
    }),
    { mcpToken: MCP, bridge: hub },
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as { result: { isError: boolean; content: { text: string }[] } };
  assert.equal(body.result.isError, false);
  assert.match(body.result.content[0]!.text, /healthy/);
  assert.deepEqual(hub.calls, [{ machine: "laptop", op: "server_info", params: {} }]);
});

test("Gemini requires a resource-bound OAuth token while OpenCode accepts MCP_TOKEN", async () => {
  const now = Date.now();
  const store = new MemoryOAuthStore(() => now);
  const oauth: OAuthConfig = {
    store,
    ownerEmails: ["owner@example.com"],
    publicOrigin: "https://relay.example",
    now: () => now,
  };
  const token = "gemini-oauth-access-token-for-test";
  await store.put(`access:${sha256(token)}`, JSON.stringify({
    clientId: "gemini-client",
    email: "owner@example.com",
    scope: "shell",
    resource: "https://relay.example/gemini/mcp",
    expiresAt: now + 60_000,
  }));
  const options = { mcpToken: MCP, bridge: bridge(), oauth };
  const request = { jsonrpc: "2.0", id: 1, method: "ping" };
  const rejected = await handleRelayRequest(mcp("POST", MCP, request, "/gemini/mcp"), options);
  assert.equal(rejected.status, 401);
  const challenge = rejected.headers.get("www-authenticate") ?? "";
  assert.match(challenge, /^Bearer /);
  assert.match(challenge, /resource_metadata="https:\/\/relay\.example\/\.well-known\/oauth-protected-resource\/gemini\/mcp"/);
  assert.match(challenge, /error="invalid_token"/);

  const accepted = await handleRelayRequest(mcp("POST", token, request, "/gemini/mcp"), options);
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { jsonrpc: "2.0", id: 1, result: {} });
  assert.equal((await handleRelayRequest(mcp("POST", MCP, request), options)).status, 200);
  assert.equal((await handleRelayRequest(mcp("POST", token, request), options)).status, 401);
});

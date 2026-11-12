import assert from "node:assert/strict";
import test from "node:test";

import { handleRelayRequest, type HubBridge } from "../src/http.ts";

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

function mcp(method: string, token?: string, body?: unknown) {
  return new Request("https://relay.example/mcp", {
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

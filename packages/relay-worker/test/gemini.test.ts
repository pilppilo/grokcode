import assert from "node:assert/strict";
import test from "node:test";

import { handleRelayRequest, type HubBridge } from "../src/http.ts";
import { MemoryOAuthStore, handleOAuthRequest, pkceS256, type OAuthConfig } from "../src/oauth.ts";

const MCP = "mcp-client-token-0123456789";
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const SECRET = "owner-approval-secret-1";

function bridge(): HubBridge & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    async listMachines() {
      return [{ name: "expinsider", connectedAt: 1 }];
    },
    async call(machine, op, params) {
      calls.push({ machine, op, params });
      return { jobId: "job_test", status: op === "shell_job" ? "exited" : "running" };
    },
  };
}

function oauth(): OAuthConfig {
  return {
    store: new MemoryOAuthStore(),
    pinnedRedirects: ["http://127.0.0.1/callback"],
    ownerEmails: ["ada@example.com"],
    approvalSecret: SECRET,
    publicOrigin: "https://relay.example",
  };
}

test("gemini mcp is a separate tool list and accepts the static bearer", async () => {
  const hub = bridge();
  const listed = await handleRelayRequest(
    new Request("https://relay.example/gemini/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${MCP}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
    { mcpToken: MCP, bridge: hub, oauth: oauth() },
  );
  const body = (await listed.json()) as {
    result: { serverInfo?: { name: string }; tools: Array<{ name: string; annotations?: { destructiveHint?: boolean; readOnlyHint?: boolean } }> };
  };
  const names = body.result.tools.map((tool) => tool.name);
  assert.equal(names.includes("start_session"), false);
  assert.equal(names.includes("apply_patch"), true);
  assert.equal(body.result.tools.find((tool) => tool.name === "run_command")?.annotations?.destructiveHint, true);
  assert.equal(body.result.tools.find((tool) => tool.name === "get_machine_info")?.annotations?.readOnlyHint, true);
  assert.equal(body.result.tools.find((tool) => tool.name === "list_machines")?.annotations?.readOnlyHint, true);

  const called = await handleRelayRequest(
    new Request("https://relay.example/gemini/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${MCP}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "run_command", arguments: { machine: "expinsider", argv: ["git", "status"], cwd: "C:\\src" } },
      }),
    }),
    { mcpToken: MCP, bridge: hub, oauth: oauth() },
  );
  assert.equal(called.status, 200);
  assert.deepEqual(hub.calls[0], {
    machine: "expinsider",
    op: "shell_run",
    params: { argv: ["git", "status"], cwd: "C:\\src" },
  });
  assert.deepEqual(hub.calls[1], {
    machine: "expinsider",
    op: "shell_job",
    params: { jobId: "job_test" },
  });
});

test("gemini mcp rejects a missing token with protected-resource metadata", async () => {
  const response = await handleRelayRequest(
    new Request("https://relay.example/gemini/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    }),
    { mcpToken: MCP, bridge: bridge(), oauth: oauth() },
  );
  assert.equal(response.status, 401);
  assert.match(response.headers.get("www-authenticate") ?? "", /resource_metadata="https:\/\/relay\.example\/\.well-known\/oauth-protected-resource\/gemini\/mcp"/);
});

test("an oauth access token can call the shell endpoint and the original /mcp stays on its own tools", async () => {
  const config = oauth();
  const registered = await handleOAuthRequest(
    new Request("https://relay.example/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["http://127.0.0.1/callback"],
        token_endpoint_auth_method: "none",
      }),
    }),
    config,
  );
  const client = (await registered.json()) as { client_id: string };
  const challenge = pkceS256(VERIFIER);
  const page = await handleOAuthRequest(
    new Request(
      `https://relay.example/oauth/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent("http://127.0.0.1/callback")}&state=s&code_challenge=${challenge}&code_challenge_method=S256`,
    ),
    config,
  );
  const txn = /name="txn" value="([^"]+)"/.exec(await page.text())?.[1];
  const approved = await handleOAuthRequest(
    new Request("https://relay.example/oauth/authorize", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ txn: txn!, secret: SECRET }),
    }),
    config,
  );
  const code = new URL(approved.headers.get("location") ?? "").searchParams.get("code");
  const traded = await handleOAuthRequest(
    new Request("https://relay.example/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code!,
        redirect_uri: "http://127.0.0.1/callback",
        client_id: client.client_id,
        code_verifier: VERIFIER,
      }),
    }),
    config,
  );
  const token = ((await traded.json()) as { access_token: string }).access_token;
  const get = await handleRelayRequest(
    new Request("https://relay.example/gemini/mcp", { headers: { authorization: `Bearer ${token}` } }),
    { mcpToken: MCP, bridge: bridge(), oauth: config },
  );
  assert.equal(get.status, 405);
  const shell = await handleRelayRequest(
    new Request("https://relay.example/gemini/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
    { mcpToken: MCP, bridge: bridge(), oauth: config },
  );
  assert.equal(shell.status, 200);
  const shellBody = (await shell.json()) as { result: { tools: Array<{ name: string }> } };
  assert.ok(shellBody.result.tools.some((tool) => tool.name === "read_file"));

  const wrong = await handleRelayRequest(
    new Request("https://relay.example/gemini/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer this-is-not-a-valid-oauth-token",
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
    { mcpToken: MCP, bridge: bridge(), oauth: config },
  );
  assert.equal(wrong.status, 401);

  const classic = await handleRelayRequest(
    new Request("https://relay.example/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${MCP}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
    { mcpToken: MCP, bridge: bridge(), oauth: config },
  );
  const classicBody = (await classic.json()) as { result: { tools: Array<{ name: string }> } };
  assert.ok(classicBody.result.tools.some((tool) => tool.name === "start_session"));
  assert.equal(classicBody.result.tools.some((tool) => tool.name === "apply_patch"), false);
});

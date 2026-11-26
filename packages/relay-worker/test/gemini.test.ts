import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createShellRuntime, parsePolicy } from "../../shell/src/index.ts";
import type { Spawned } from "../../shell/src/spawn.ts";

import { handleRelayRequest, type HubBridge } from "../src/http.ts";
import { MemoryOAuthStore, handleOAuthRequest, pkceS256, sha256, type OAuthConfig } from "../src/oauth.ts";

const MCP = "mcp-client-token-0123456789";
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const SECRET = "owner-approval-secret-1";
const LEGACY_SCOPE = sha256(JSON.stringify(["ada@example.com", "test-client", null]));

function bridge(): HubBridge & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    async listMachines() {
      return [{ name: "my-pc", connectedAt: 1 }];
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

async function authenticatedShell() {
  const config = oauth();
  const token = "test-shell-access-token-0123456789";
  await config.store.put(`access:${sha256(token)}`, JSON.stringify({
    clientId: "test-client",
    email: "ada@example.com",
    scope: "shell",
    resource: "https://relay.example/gemini/mcp",
    expiresAt: Date.now() + 60_000,
  }));
  return { config, token };
}

test("gemini mcp lists shell tools and forwards calls with OAuth", async () => {
  const hub = bridge();
  const { config, token } = await authenticatedShell();
  const listed = await handleRelayRequest(
    new Request("https://relay.example/gemini/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
    { mcpToken: MCP, bridge: hub, oauth: config },
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
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "run_command", arguments: { machine: "my-pc", argv: ["git", "status"], cwd: "C:\\src" } },
      }),
    }),
    { mcpToken: MCP, bridge: hub, oauth: config },
  );
  assert.equal(called.status, 200);
  assert.deepEqual(hub.calls[0], {
    machine: "my-pc",
    op: "shell_run",
    params: { argv: ["git", "status"], cwd: "C:\\src", sessionScope: LEGACY_SCOPE },
  });
  assert.equal(hub.calls.length, 2);
  const held = hub.calls[1] as { machine: string; op: string; params: { jobId: string; holdMs: number } };
  assert.equal(held.op, "shell_job");
  assert.equal(held.machine, "my-pc");
  assert.equal(held.params.jobId, "job_test");
  assert.ok(held.params.holdMs > 40_000 && held.params.holdMs <= 45_000);
});

test("Gemini sessions isolate jobs, notices, and audit across restarts", async () => {
  const { config, token } = await authenticatedShell();
  const temp = mkdtempSync(path.join(tmpdir(), "grokcode-session-"));
  const root = path.join(temp, "workspace");
  const outputDir = path.join(temp, "output");
  const taskDir = path.join(temp, "tasks");
  const auditPath = path.join(temp, "audit.log");
  mkdirSync(root);
  const platform = process.platform === "win32" ? "win32" : "posix";
  const policy = parsePolicy(JSON.stringify({
    version: 1, roots: [root], allowJobInput: true, allow: [{ command: "echo" }],
    projects: { sample: { root, testCommand: ["echo"] } },
  }), platform, temp);
  const createAgent = () => createShellRuntime({
    platform, home: temp, auditPath, outputDir, taskDir, loadPolicy: () => ({ policy, source: "test" }),
    spawnImpl: () => {
      let finish: Parameters<Spawned["onExit"]>[0];
      return {
        stdout: null, stderr: null,
        kill: () => finish(null, "SIGTERM"),
        onExit: (callback) => { finish = callback; },
      };
    },
  });
  let agent = createAgent();
  const createRelay = () => ({
    oauth: config,
    bridge: {
      listMachines: async () => [{ name: "my-pc", connectedAt: 1 }],
      call: (_machine: string, op: string, params: unknown) => agent.execute(op, params),
    },
  });
  let relay = createRelay();
  const request = (method: string, params?: unknown, sessionId?: string) => handleRelayRequest(
    new Request("https://relay.example/gemini/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }), relay,
  );
  const tool = async (sessionId: string | undefined, name: string, args: unknown = {}) => {
    const response = await request("tools/call", { name, arguments: args }, sessionId);
    assert.equal(response.status, 200);
    const { result } = await response.json() as { result: { content: Array<{ text: string }> } };
    return JSON.parse(result.content[0]!.text);
  };
  try {
    const initialized = await request("initialize");
    assert.equal(initialized.headers.get("access-control-expose-headers"), "Mcp-Session-Id");
    const first = initialized.headers.get("mcp-session-id")!;
    const second = (await request("initialize", undefined, first)).headers.get("mcp-session-id")!;
    assert.match(first, /^[A-Za-z0-9_-]{43}$/);
    assert.match(second, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(first, second);

    const command = { cwd: root, argv: ["echo"], wait: false };
    const [a, b] = await Promise.all([tool(first, "run_command", command), tool(second, "run_command", command)]);
    assert.equal(a.status, "running");
    assert.equal(b.status, "running");
    assert.deepEqual((await tool(first, "list_jobs")).jobs.map((job: { jobId: string }) => job.jobId), [a.jobId]);
    assert.deepEqual((await tool(second, "list_jobs")).jobs.map((job: { jobId: string }) => job.jobId), [b.jobId]);
    assert.deepEqual((await tool(undefined, "list_jobs")).jobs, []);
    const aScope = sha256(JSON.stringify(["ada@example.com", "test-client", first]));
    for (const name of ["get_job", "poll_output", "kill_job", "send_input", "read_file"]) {
      const denied = await tool(second, name, {
        jobId: a.jobId, input: "\n", path: `grokcode-output:${a.jobId}`, sessionScope: aScope,
      });
      assert.equal(denied.error, "job_not_found", name);
    }

    relay = createRelay();
    assert.equal((await tool(first, "get_job", { jobId: a.jobId, wait: false })).status, "running");
    await tool(first, "kill_job", { jobId: a.jobId });
    assert.deepEqual((await tool(second, "list_jobs")).notices, []);
    assert.deepEqual((await tool(first, "list_jobs")).notices.map((notice: { jobId: string }) => notice.jobId), [a.jobId]);
    assert.deepEqual((await tool(first, "list_jobs")).notices, []);
    assert.ok(readFileSync(auditPath, "utf8").split("\n").filter(Boolean).some((line) => {
      const row = JSON.parse(line);
      return row.tool === "shell_run" && row.jobId === a.jobId && row.sessionId === aScope;
    }));

    const task = await tool(first, "run_task", { project: "sample" });
    assert.match(task.taskId, /^task_/);
    assert.equal((await tool(second, "cancel_task", { taskId: task.taskId })).error, "task_not_found");
    await tool(first, "cancel_task", { taskId: task.taskId });
    agent.killAll();
    agent = createAgent();
    assert.equal((await tool(second, "get_task_activity", { taskId: task.taskId })).error, "task_not_found");
    assert.equal((await tool(first, "get_task_status", { taskId: task.taskId })).phase, "cancelled");
    assert.deepEqual((await tool(first, "list_jobs")).jobs, []);
    assert.equal((await tool(first, "get_job", { jobId: a.jobId, wait: false })).error, "job_not_found");
    assert.equal((await tool(first, "run_command", command)).status, "running");
  } finally {
    agent.killAll();
    await new Promise<void>((resolve) => setImmediate(resolve));
    rmSync(temp, { recursive: true, force: true });
  }
});

test("Gemini keeps a job status request open until the agent returns its result", { timeout: 2_000 }, async () => {
  const { config, token } = await authenticatedShell();
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  let finish!: (value: unknown) => void;
  const finished = new Promise<unknown>((resolve) => { finish = resolve; });
  let completed = false;
  const result = handleRelayRequest(new Request("https://relay.example/gemini/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "get_job", arguments: { jobId: "job_test" } },
    }),
  }), {
    mcpToken: MCP, oauth: config, maxSyncWaitMs: 30_000,
    bridge: {
      listMachines: async () => [{ name: "my-pc", connectedAt: 1 }],
      async call(_machine, op, params, timeoutMs) {
        enter();
        return finished.then((result) => {
          assert.equal(op, "shell_job");
          assert.deepEqual(params, { jobId: "job_test", holdMs: 30_000, sessionScope: LEGACY_SCOPE });
          assert.equal(timeoutMs, 35_000);
          return result;
        });
      },
    },
  }).then((response) => {
    completed = true;
    return response;
  });
  await entered;
  assert.equal(completed, false);
  const job = { jobId: "job_test", status: "exited", exitCode: 7, output: "done" };
  finish(job);
  const body = await (await result).json() as { result: { content: Array<{ text: string }> } };
  assert.deepEqual(JSON.parse(body.result.content[0]!.text), job);
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

test("code mode is opt-in and derives ownership from the OAuth token", async () => {
  const { config, token } = await authenticatedShell();
  const calls: Array<{ op: string; params: unknown; timeoutMs?: number }> = [];
  const hub: HubBridge = {
    listMachines: async () => [{ name: "my-pc", connectedAt: 1 }],
    async call(_machine, op, params, timeoutMs) {
      calls.push({ op, params, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
      return { executionId: "exec_fixture", status: "running" };
    },
  };
  const call = async (enabled: boolean, method: string, params?: unknown) => {
    const response = await handleRelayRequest(new Request("https://relay.example/gemini/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }), { mcpToken: MCP, bridge: hub, oauth: config, enableCodeMode: enabled });
    return (await response.json()).result;
  };
  assert.equal((await call(false, "tools/list")).tools.some((tool: { name: string }) => tool.name === "execute"), false);
  assert.equal((await call(true, "tools/list")).tools.some((tool: { name: string }) => tool.name === "execute"), true);
  const params = { name: "execute", arguments: { code: "return 1", owner: "forged" } };
  assert.equal((await call(false, "tools/call", params)).isError, true);
  assert.equal(calls.length, 0);
  const result = await call(true, "tools/call", params);
  assert.deepEqual(JSON.parse(result.content[0].text), { executionId: "exec_fixture", status: "running", machine: "my-pc" });
  assert.deepEqual(calls, [{
    op: "shell_code_execute",
    params: { code: "return 1", owner: LEGACY_SCOPE, holdMs: 45_000, sessionScope: LEGACY_SCOPE },
    timeoutMs: 50_000,
  }]);
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

test("gemini surfaces a push failure as an error that still contains the commit SHA", async () => {
  const { config, token } = await authenticatedShell();
  const sha = "abc123def456abc123def456abc123def456abcd";
  let mode: "clean" | "local" | "failed" | "fallback" = "clean";
  const hub: HubBridge = {
    async listMachines() {
      return [{ name: "my-pc", connectedAt: 1 }];
    },
    async call() {
      if (mode === "clean") return { branch: "main", sha, pushed: true, output: "ok" };
      if (mode === "local") return { branch: "main", sha, pushed: false, output: "committed" };
      if (mode === "fallback") {
        return {
          branch: "main",
          sha,
          pushed: false,
          output: "nope",
          push: { ok: false, code: "push_failed", error: "origin unreachable" },
        };
      }
      return {
        branch: "main",
        sha,
        pushed: false,
        committed: true,
        output: "rejected",
        push: { ok: false, code: "push_failed", error: "origin unreachable" },
        message: `Commit ${sha} was created on branch main. The push failed: origin unreachable. This commit already exists. Do not create another commit. Retry only the push.`,
      };
    },
  };
  async function callTool(): Promise<{ isError: boolean; json: Record<string, unknown> }> {
    const response = await handleRelayRequest(
      new Request("https://relay.example/gemini/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 9,
          method: "tools/call",
          params: {
            name: "git_commit_push",
            arguments: { cwd: "/src", message: "note", paths: ["a.txt"], push: true },
          },
        }),
      }),
      { mcpToken: MCP, bridge: hub, oauth: config },
    );
    const body = (await response.json()) as { result: { isError: boolean; content: { text: string }[] } };
    return { isError: body.result.isError, json: JSON.parse(body.result.content[0]!.text) as Record<string, unknown> };
  }
  const clean = await callTool();
  assert.equal(clean.isError, false);
  assert.equal(clean.json.sha, sha);
  mode = "local";
  const local = await callTool();
  assert.equal(local.isError, false);
  assert.equal(local.json.pushed, false);
  mode = "failed";
  const failed = await callTool();
  assert.equal(failed.isError, true);
  assert.equal(failed.json.error, "push_failed");
  assert.equal(failed.json.sha, sha);
  assert.equal(failed.json.committed, true);
  assert.equal(failed.json.pushed, false);
  assert.match(String(failed.json.message), /Do not create another commit/);
  assert.match(String(failed.json.message), /Retry only the push/);
  mode = "fallback";
  const fallback = await callTool();
  assert.equal(fallback.isError, true);
  assert.equal(fallback.json.sha, sha);
  assert.match(String(fallback.json.message), new RegExp(sha));
  assert.match(String(fallback.json.message), /Do not create another commit/);
  assert.match(String(fallback.json.message), /Retry only the push/);
});

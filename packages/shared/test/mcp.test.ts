import assert from "node:assert/strict";
import test from "node:test";

import { handleMcpRequest, type Clock, type MachineBackend } from "../src/mcp.ts";
import type { MachineInfo } from "../src/hub.ts";

function backend(partial: Partial<MachineBackend> & { calls?: { op: string; params: unknown }[] } = {}): MachineBackend & {
  calls: { op: string; params: unknown }[];
} {
  const calls = partial.calls ?? [];
  const machines: MachineInfo[] = partial.listMachines
    ? []
    : [{ name: "laptop", connectedAt: 1, api: "v2", version: "2.2.1" }];
  return {
    mode: partial.mode ?? "relay",
    calls,
    listMachines: partial.listMachines ?? (async () => machines),
    call: partial.call ?? (async (machine, op, params) => {
      calls.push({ op, params });
      assert.equal(machine, "laptop");
      if (op === "server_info") return { api: "v2", version: "2.2.1", healthy: true };
      if (op === "send_prompt") return { accepted: true, sessionId: "ses_1", messageId: "msg_1" };
      if (op === "get_session") return { session: { id: "ses_1", activity: "busy", directory: "/work" } };
      if (op === "list_pending_permissions") return { permissions: [] };
      if (op === "get_messages") return { messages: [] };
      return { ok: true };
    }),
  };
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://relay.example/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function toolText(response: Response): Promise<{ text: string; isError: boolean }> {
  const body = (await response.json()) as {
    result?: { content?: { text: string }[]; isError?: boolean };
    error?: { message: string };
  };
  assert.equal(response.status, 200);
  if (body.error) return { text: body.error.message, isError: true };
  return { text: body.result?.content?.[0]?.text ?? "", isError: body.result?.isError === true };
}

test("initialize and tools/list advertise the shared surface", async () => {
  const response = await handleMcpRequest(
    post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }),
    { backend: backend() },
  );
  const body = (await response.json()) as { result: { protocolVersion: string; serverInfo: { name: string } } };
  assert.equal(body.result.protocolVersion, "2025-03-26");
  assert.equal(body.result.serverInfo.name, "grokcode");

  const list = await handleMcpRequest(post({ jsonrpc: "2.0", id: 2, method: "tools/list" }), { backend: backend() });
  const listed = ((await list.json()) as { result: { tools: { name: string; description: string }[] } }).result.tools;
  const tools = listed.map((tool) => tool.name);
  const starter = listed.find((tool) => tool.name === "start_opencode");
  assert.match(starter?.description ?? "", /only call when the user explicitly asks to open\/start OpenCode/);
  assert.equal(listed.some((tool) => /stop_opencode|restart_opencode/.test(tool.name)), false);
  for (const name of [
    "list_machines",
    "opencode_status",
    "start_opencode",
    "start_session",
    "send_prompt",
    "get_messages",
    "get_message",
    "get_session_summary",
    "get_diff",
    "list_pending_permissions",
    "respond_permission",
    "abort",
    "wait_session",
  ]) {
    assert.ok(tools.includes(name), name);
  }
});

test("notifications get 202 and unknown tools are tool errors", async () => {
  const note = await handleMcpRequest(
    post({ jsonrpc: "2.0", method: "notifications/initialized" }),
    { backend: backend() },
  );
  assert.equal(note.status, 202);

  const missing = await handleMcpRequest(
    post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "rm_rf", arguments: {} } }),
    { backend: backend() },
  );
  const body = await toolText(missing);
  assert.equal(body.isError, true);
  assert.match(body.text, /unknown_tool/);
});

test("send_prompt async does not poll, and wait returns running when the budget expires", async () => {
  const calls: { op: string; params: unknown }[] = [];
  let ticks = 0;
  const clock: Clock = {
    now: () => ticks,
    sleep: async (ms) => {
      ticks += ms;
    },
  };
  const relay = backend({
    calls,
    call: async (_machine, op, params) => {
      calls.push({ op, params });
      if (op === "send_prompt") return { accepted: true, sessionId: "ses_1" };
      if (op === "get_session") return { session: { id: "ses_1", activity: "busy" } };
      if (op === "list_pending_permissions") return { permissions: [] };
      if (op === "get_messages") return { messages: [{ id: "m", role: "assistant", text: "partial" }] };
      return {};
    },
  });

  const asyncRes = await handleMcpRequest(
    post({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "send_prompt", arguments: { sessionId: "ses_1", text: "go" } },
    }),
    { backend: relay, clock },
  );
  const asyncBody = await toolText(asyncRes);
  assert.equal(asyncBody.isError, false);
  assert.match(asyncBody.text, /accepted/);
  assert.deepEqual(calls.map((call) => call.op), ["send_prompt"]);

  calls.length = 0;
  ticks = 0;
  const waitRes = await handleMcpRequest(
    post({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "send_prompt", arguments: { sessionId: "ses_1", text: "go", wait: true, timeoutMs: 1500 } },
    }),
    { backend: relay, clock, pollMs: 500, maxSyncWaitMs: 20_000 },
  );
  const waitBody = JSON.parse((await toolText(waitRes)).text) as { status: string; timedOut: boolean };
  assert.equal(waitBody.status, "running");
  assert.equal(waitBody.timedOut, true);
  assert.ok(calls.filter((call) => call.op === "get_session").length >= 2);
});

test("wait returns needs_permission without burning the whole budget", async () => {
  let ticks = 0;
  const clock: Clock = {
    now: () => ticks,
    sleep: async (ms) => {
      ticks += ms;
    },
  };
  const relay = backend({
    call: async (_machine, op) => {
      if (op === "get_session") return { session: { id: "ses_1", activity: "busy" } };
      if (op === "list_pending_permissions") {
        return { permissions: [{ id: "per_1", action: "shell" }] };
      }
      return {};
    },
  });
  const response = await handleMcpRequest(
    post({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "wait_session", arguments: { sessionId: "ses_1", timeoutMs: 10_000 } },
    }),
    { backend: relay, clock, pollMs: 500 },
  );
  const body = JSON.parse((await toolText(response)).text) as { status: string };
  assert.equal(body.status, "needs_permission");
  assert.ok(ticks < 10_000);
});

test("direct mode defaults the machine and a browser origin is rejected", async () => {
  const direct = backend({ mode: "direct" });
  const ok = await handleMcpRequest(
    post({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "server_info", arguments: {} },
    }),
    { backend: direct },
  );
  assert.match((await toolText(ok)).text, /2\.2\.1/);

  const blocked = await handleMcpRequest(
    post(
      { jsonrpc: "2.0", id: 8, method: "tools/list" },
      { origin: "https://evil.example" },
    ),
    { backend: direct },
  );
  assert.equal(blocked.status, 403);
});

test("a large tool result keeps the end and marks the cut", async () => {
  const ending = "FINAL_ANSWER_END";
  const relay = backend({
    call: async () => ({ blob: `START_${"x".repeat(100_000)}${ending}` }),
  });
  const response = await handleMcpRequest(
    post({
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "server_info", arguments: { machine: "laptop" } },
    }),
    { backend: relay },
  );
  const body = await toolText(response);
  assert.equal(body.isError, false);
  assert.match(body.text, /omitted \d+ characters from the start/);
  assert.equal(body.text.includes("START_"), false);
  assert.ok(body.text.endsWith(`${ending}"\n}`));
});

test("relay mode requires a machine when two are online", async () => {
  const relay = backend({
    listMachines: async () => [
      { name: "laptop", connectedAt: 1 },
      { name: "desktop", connectedAt: 2 },
    ],
  });
  const response = await handleMcpRequest(
    post({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "server_info", arguments: {} },
    }),
    { backend: relay },
  );
  const body = await toolText(response);
  assert.equal(body.isError, true);
  assert.match(body.text, /machine is required/);
});

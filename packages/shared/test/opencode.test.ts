import assert from "node:assert/strict";
import test from "node:test";

import { detectOpenCode, OpenCodeClient, parseModel, permissionDecision } from "../src/opencode.ts";

interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  body?: unknown;
  authorization?: string | null;
  directory?: string | null;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(body == null ? null : JSON.stringify(body), {
    status,
    headers: body == null ? {} : { "content-type": "application/json" },
  });
}

function install(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    let body: unknown;
    if (typeof init?.body === "string") body = JSON.parse(init.body);
    const call: Call = {
      method: init?.method ?? "GET",
      path: url.pathname,
      query: url.searchParams,
      body,
      authorization: headers.get("authorization"),
      directory: headers.get("x-opencode-directory"),
    };
    calls.push(call);
    return handler(call);
  };
  return { calls, fetchImpl };
}

test("parseModel and permission decisions", () => {
  assert.deepEqual(parseModel("anthropic/claude-sonnet-5"), { providerID: "anthropic", id: "claude-sonnet-5" });
  assert.deepEqual(parseModel({ providerID: "openai", modelID: "gpt-5" }), { providerID: "openai", id: "gpt-5" });
  assert.throws(() => parseModel("noslash"));
  assert.equal(permissionDecision("approve"), "once");
  assert.equal(permissionDecision("deny"), "reject");
  assert.equal(permissionDecision("always"), "always");
});

test("v2 client admits prompts without blocking and answers permissions", async () => {
  const active = new Set<string>();
  const { calls, fetchImpl } = install((call) => {
    if (call.path === "/api/info") return jsonResponse({ version: "2.2.1", pid: 1, urls: [] });
    if (call.path === "/api/project") return jsonResponse([{ id: "prj_1", name: "app", canonical: "/work/app" }]);
    if (call.path === "/api/session" && call.method === "GET") {
      return jsonResponse({ data: [{ id: "ses_1", title: "fix", location: { directory: "/work/app" } }] });
    }
    if (call.path === "/api/session" && call.method === "POST") {
      assert.equal((call.body as { location: { directory: string } }).location.directory, "/work/app");
      return jsonResponse({ data: { id: "ses_new", title: "new", location: { directory: "/work/app" } } });
    }
    if (call.path === "/api/session/ses_new/model") return jsonResponse(null, 204);
    if (call.path === "/api/session/ses_new/prompt") {
      active.add("ses_new");
      assert.equal((call.body as { text: string }).text, "hello");
      assert.equal((call.body as { resume: boolean }).resume, true);
      return jsonResponse({ data: { id: "msg_1", delivery: "queue" } });
    }
    if (call.path === "/api/session/active") return jsonResponse({ data: Object.fromEntries([...active].map((id) => [id, {}])) });
    if (call.path === "/api/session/ses_1") return jsonResponse({ data: { id: "ses_1", location: { directory: "/work/app" } } });
    if (call.path === "/api/session/ses_new") return jsonResponse({ data: { id: "ses_new", location: { directory: "/work/app" } } });
    if (call.path === "/api/session/ses_1/message/msg_a") {
      return jsonResponse({ data: { id: "msg_a", type: "assistant", content: [{ type: "text", text: "pong" }] } });
    }
    if (call.path === "/api/session/ses_1/message") {
      return jsonResponse({
        data: [
          { id: "msg_u", type: "user", text: "hello" },
          { id: "msg_a", type: "assistant", parts: [{ type: "text", text: "pong" }] },
        ],
      });
    }
    if (call.path === "/api/session/ses_1/diff") return jsonResponse({ data: [{ file: "a.ts", additions: 1, deletions: 0, patch: "+a" }] });
    if (call.path === "/api/session/ses_1/permission") {
      return jsonResponse({ data: [{ id: "per_1", sessionID: "ses_1", action: "shell", resources: ["ls"] }] });
    }
    if (call.path === "/api/session/ses_1/permission/per_1/reply") {
      assert.deepEqual(call.body, { decision: "once", message: null });
      return jsonResponse(null, 204);
    }
    if (call.path === "/api/session/ses_1/interrupt") return jsonResponse({ interrupted: true });
    if (call.path === "/api/agent") return jsonResponse({ data: [{ id: "build", name: "Build" }] });
    if (call.path === "/api/model") return jsonResponse({ data: [{ id: "claude-sonnet-5", providerID: "anthropic", name: "Sonnet" }] });
    return jsonResponse({ message: `missing ${call.method} ${call.path}` }, 404);
  });

  const client = await detectOpenCode({
    baseUrl: "http://127.0.0.1:4096",
    auth: { username: "opencode", password: "secret-password" },
    fetch: fetchImpl,
  });
  assert.equal(client.api, "v2");
  assert.equal(client.version, "2.2.1");
  assert.match(calls[0]?.authorization ?? "", /^Basic /);

  const projects = await client.listProjects();
  assert.equal(projects[0]?.directory, "/work/app");
  const sessions = await client.listSessions({ directory: "/work/app" });
  assert.equal(sessions[0]?.id, "ses_1");
  const listCall = calls.find((call) => call.path === "/api/session" && call.method === "GET");
  assert.equal(listCall?.query.get("location[directory]"), "/work/app");
  assert.equal(listCall?.directory, encodeURIComponent("/work/app"));

  const created = await client.startSession({ directory: "/work/app", model: "anthropic/claude-sonnet-5", title: "new" });
  assert.equal(created.id, "ses_new");
  const prompt = await client.sendPrompt({ sessionId: "ses_new", text: "hello", model: "anthropic/claude-sonnet-5" });
  assert.equal(prompt.messageId, "msg_1");
  assert.equal(calls.some((call) => call.path.endsWith("/message") && call.method === "POST"), false);

  const session = await client.getSession("ses_1");
  assert.equal(session.activity, "idle");
  const busy = await client.getSession("ses_new");
  assert.equal(busy.activity, "busy");

  const messages = await client.getMessages("ses_1");
  assert.equal(messages[0]?.id, "msg_a");
  assert.equal(messages[0]?.text, "pong");
  assert.equal(messages[1]?.text, "hello");
  const messageCall = calls.find((call) => call.path === "/api/session/ses_1/message");
  assert.equal(messageCall?.query.get("order"), "desc");
  const one = await client.getMessage("ses_1", "msg_a");
  assert.equal(one.text, "pong");
  assert.equal(one.id, "msg_a");
  const diff = await client.getDiff("ses_1", "msg_u");
  assert.equal(diff[0]?.file, "a.ts");
  assert.equal(calls.find((call) => call.path.endsWith("/diff"))?.query.get("from"), "msg_u");

  const permissions = await client.listPermissions({ sessionId: "ses_1" });
  assert.equal(permissions[0]?.action, "shell");
  const reply = await client.respondPermission({ sessionId: "ses_1", requestId: "per_1", decision: "approve" });
  assert.equal(reply.decision, "once");
  const aborted = await client.abort("ses_1");
  assert.equal(aborted.aborted, true);
  assert.equal((await client.listAgents()).length, 1);
  assert.equal((await client.listModels())[0]?.providerId, "anthropic");
});

test("v1 fallback uses prompt_async, abort, and permission reply", async () => {
  const { calls, fetchImpl } = install((call) => {
    if (call.path === "/api/info") return new Response("<html>web</html>", { headers: { "content-type": "text/html" } });
    if (call.path === "/global/health") return jsonResponse({ healthy: true, version: "1.2.0" });
    if (call.path === "/session" && call.method === "POST") return jsonResponse({ id: "ses_v1", title: "t", directory: "/work/app" });
    if (call.path === "/session/ses_v1/prompt_async") return jsonResponse(null, 204);
    if (call.path === "/session/ses_v1") return jsonResponse({ id: "ses_v1", directory: "/work/app" });
    if (call.path === "/session/status") return jsonResponse({ ses_v1: { type: "busy" } });
    if (call.path === "/session/ses_v1/message") {
      return jsonResponse([{ info: { id: "m1", role: "user" }, parts: [{ type: "text", text: "hi" }] }]);
    }
    if (call.path === "/session/ses_v1/permissions/per_9") return jsonResponse(false, 404);
    if (call.path === "/permission/per_9/reply") {
      assert.equal((call.body as { reply: string }).reply, "reject");
      return jsonResponse(true);
    }
    if (call.path === "/permission") return jsonResponse([{ id: "per_9", sessionID: "ses_v1", permission: "bash", patterns: ["*"] }]);
    if (call.path === "/session/ses_v1/abort") return jsonResponse(true);
    if (call.path === "/session/ses_v1/diff") return jsonResponse([{ file: "b.ts", additions: 2, deletions: 1 }]);
    return jsonResponse({ message: `missing ${call.path}` }, 404);
  });

  const client = await detectOpenCode({ baseUrl: "http://127.0.0.1:4096/", fetch: fetchImpl });
  assert.equal(client.api, "v1");
  assert.equal(client.version, "1.2.0");
  const created = await client.startSession({ directory: "/work/app", title: "t" });
  assert.equal(created.id, "ses_v1");
  await client.sendPrompt({ sessionId: "ses_v1", text: "hi", model: "openai/gpt-5" });
  assert.equal(calls.some((call) => call.path.endsWith("/prompt_async")), true);
  assert.equal(calls.some((call) => call.method === "POST" && call.path.endsWith("/message")), false);
  const prompt = calls.find((call) => call.path.endsWith("/prompt_async"));
  assert.deepEqual((prompt?.body as { model: unknown }).model, { providerID: "openai", modelID: "gpt-5" });

  const session = await client.getSession("ses_v1");
  assert.equal(session.activity, "busy");
  const messages = await client.getMessages("ses_v1");
  assert.equal(messages[0]?.text, "hi");
  assert.equal(calls.find((call) => call.path === "/session/ses_v1/message")?.query.get("order"), null);
  const one = await client.getMessage("ses_v1", "m1");
  assert.equal(one.text, "hi");
  assert.equal(one.role, "user");
  const permissions = await client.listPermissions({ sessionId: "ses_v1" });
  assert.equal(permissions[0]?.action, "bash");
  const reply = await client.respondPermission({
    sessionId: "ses_v1",
    requestId: "per_9",
    decision: "deny",
    message: "no",
  });
  assert.equal(reply.decision, "reject");
  await client.abort("ses_v1");
  const diff = await client.getDiff("ses_v1", "m1");
  assert.equal(diff[0]?.deletions, 1);
  assert.equal(calls.find((call) => call.path.endsWith("/diff"))?.query.get("messageID"), "m1");
});

test("401 does not fall through to the other API generation", async () => {
  const { fetchImpl } = install(() => jsonResponse({ message: "nope" }, 401));
  await assert.rejects(
    () => detectOpenCode({ baseUrl: "http://127.0.0.1:4096", auth: { username: "opencode", password: "x" }, fetch: fetchImpl }),
    /401/,
  );
});

test("executor allowlist blocks a session outside the roots", async () => {
  const { executeOp } = await import("../src/executor.ts");
  const { fetchImpl } = install((call) => {
    if (call.path === "/api/session/ses_ok") return jsonResponse({ data: { id: "ses_ok", location: { directory: "/work/ok" } } });
    if (call.path === "/api/session/active") return jsonResponse({ data: {} });
    if (call.path === "/api/session/ses_no") return jsonResponse({ data: { id: "ses_no", location: { directory: "/secret" } } });
    if (call.path === "/api/session" && call.method === "POST") {
      return jsonResponse({ data: { id: "ses_new", location: { directory: "/work/ok/app" } } });
    }
    return jsonResponse({ message: "no" }, 404);
  });
  const api = new OpenCodeClient({ baseUrl: "http://127.0.0.1:4096", api: "v2", fetch: fetchImpl });
  const ctx = { api, allowDirs: ["/work/ok"], platform: "posix" as const, home: "/home/ada" };
  await assert.rejects(() => executeOp(ctx, "send_prompt", { sessionId: "ses_no", text: "x" }), /allowlist/);
  await assert.rejects(() => executeOp(ctx, "start_session", { directory: "/etc" }), /allowlist/);
  const started = await executeOp(ctx, "start_session", { directory: "/work/ok/app" });
  assert.equal((started as { session: { id: string } }).session.id, "ses_new");
  await assert.rejects(() => executeOp(ctx, "get_session", { sessionId: "../etc" }), /sessionId/);
});

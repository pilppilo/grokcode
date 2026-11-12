import assert from "node:assert/strict";
import test from "node:test";

import { executeOp } from "../src/executor.ts";
import { OpenCodeClient } from "../src/opencode.ts";

const MODEL = "opencode-go/deepseek-v4.1-flash";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("default model fills start_session and send_prompt and is reported by server_info", async () => {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method: init?.method ?? "GET", path: url.pathname, body });
    if (url.pathname === "/api/info") return json({ version: "2.2.7" });
    if (url.pathname === "/api/session" && init?.method === "POST") {
      return json({ data: { id: "ses_new", location: { directory: "/work/app" } } });
    }
    if (url.pathname === "/api/session/ses_new") return json({ data: { id: "ses_new", location: { directory: "/work/app" } } });
    if (url.pathname === "/api/session/active") return json({ data: {} });
    if (url.pathname === "/api/session/ses_new/model") return json(null);
    if (url.pathname === "/api/session/ses_new/prompt") return json({ data: { id: "msg_1" } });
    return json({ message: "no" }, 404);
  };
  const api = new OpenCodeClient({ baseUrl: "http://127.0.0.1:4096", api: "v2", fetch: fetchImpl });
  const ctx = { api, allowDirs: ["/work"], platform: "posix" as const, home: "/home/ada", defaultModel: MODEL };

  const info = (await executeOp(ctx, "server_info", {})) as { api: string; version?: string; defaultModel: string | null };
  assert.equal(info.api, "v2");
  assert.equal(info.version, "2.2.7");
  assert.equal(info.defaultModel, MODEL);

  await executeOp(ctx, "start_session", { directory: "/work/app" });
  const created = calls.find((call) => call.path === "/api/session" && call.method === "POST");
  assert.deepEqual((created?.body as { model: unknown }).model, { providerID: "opencode-go", id: "deepseek-v4.1-flash" });

  await executeOp(ctx, "send_prompt", { sessionId: "ses_new", text: "hello" });
  const selected = calls.find((call) => call.path === "/api/session/ses_new/model");
  assert.deepEqual(selected?.body, { model: { providerID: "opencode-go", id: "deepseek-v4.1-flash" } });

  calls.length = 0;
  await executeOp(ctx, "start_session", { directory: "/work/app", model: "other/explicit" });
  const explicit = calls.find((call) => call.path === "/api/session" && call.method === "POST");
  assert.deepEqual((explicit?.body as { model: unknown }).model, { providerID: "other", id: "explicit" });

  const unset = (await executeOp({ api, platform: "posix", home: "/home/ada" }, "server_info", {})) as { defaultModel: string | null };
  assert.equal(unset.defaultModel, null);
});

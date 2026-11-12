import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { listenDirect } from "../src/server.ts";

const MCP = "mcp-token-0123456789abcdef";

async function mockOpenCode() {
  const seen: { method?: string; url?: string; authorization?: string | null }[] = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
    const path = req.url?.split("?")[0];
    res.setHeader("content-type", "application/json");
    if (path === "/api/info") {
      res.end(JSON.stringify({ version: "2.2.1", pid: 1 }));
      return;
    }
    if (path === "/api/session" && req.method === "GET") {
      res.end(JSON.stringify({ data: [{ id: "ses_1", title: "demo", location: { directory: "/work/app" } }] }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ message: "no" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    seen,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

test("direct MCP lists sessions through the local OpenCode API", async () => {
  const opencode = await mockOpenCode();
  const agent = await listenDirect({
    host: "127.0.0.1",
    port: 0,
    name: "laptop",
    mcpToken: MCP,
    allowDirs: ["/work"],
    getApi: async () => {
      const { detectOpenCode } = await import("grokcode-shared");
      return detectOpenCode({
        baseUrl: opencode.url,
        auth: { username: "opencode", password: "local-secret" },
      });
    },
  });
  try {
    const health = await fetch(`${agent.url}/health`);
    assert.equal((await health.json() as { machine: string }).machine, "laptop");

    const denied = await fetch(`${agent.url}/mcp`, { method: "POST", body: "{}" });
    assert.equal(denied.status, 401);

    const response = await fetch(`${agent.url}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${MCP}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "list_sessions", arguments: { directory: "/work/app" } },
      }),
    });
    const body = (await response.json()) as { result: { isError?: boolean; content: { text: string }[] } };
    assert.equal(body.result.isError, false);
    assert.match(body.result.content[0]!.text, /ses_1/);
    assert.ok(opencode.seen.some((call) => call.authorization?.startsWith("Basic ")));

    const outside = await fetch(`${agent.url}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${MCP}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "list_sessions", arguments: { directory: "/etc" } },
      }),
    });
    const blocked = (await outside.json()) as { result: { isError: boolean; content: { text: string }[] } };
    assert.equal(blocked.result.isError, true);
    assert.match(blocked.result.content[0]!.text, /allowlist/);
  } finally {
    await agent.close();
    await opencode.close();
  }
});

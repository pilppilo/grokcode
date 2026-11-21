import assert from "node:assert/strict";
import test from "node:test";

import { createShellRuntime } from "../src/execute.ts";
import { createFrameParser, encodeFrame, handleStdioMessage, localBackend } from "../src/stdio.ts";

test("stdio framing round-trips Content-Length and newline JSON", () => {
  const seen: unknown[] = [];
  const parser = createFrameParser(
    (message) => seen.push(message),
    (err) => {
      throw err;
    },
  );
  const payload = { jsonrpc: "2.0", id: 1, method: "ping" };
  const frame = encodeFrame(payload);
  parser(frame.subarray(0, 10));
  assert.equal(seen.length, 0);
  parser(frame.subarray(10));
  parser(Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })}\n`));
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0], payload);
});

test("the stdio server lists shell tools and defaults the machine", async () => {
  const runtime = createShellRuntime({
    platform: "posix",
    home: "/tmp",
    loadPolicy: () => ({ policy: null, source: "(unset)", error: "no policy" }),
  });
  const backend = localBackend("expinsider", runtime);
  const listed = (await handleStdioMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" }, backend)) as {
    result: { tools: Array<{ name: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }> };
  };
  const run = listed.result.tools.find((tool) => tool.name === "run_command");
  const machines = listed.result.tools.find((tool) => tool.name === "list_machines");
  assert.equal(run?.annotations?.destructiveHint, true);
  assert.equal(machines?.annotations?.readOnlyHint, true);
  const info = (await handleStdioMessage(
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_machine_info", arguments: {} } },
    backend,
  )) as { result: { isError: boolean; content: Array<{ text: string }> } };
  assert.equal(info.result.isError, false);
  assert.match(info.result.content[0]!.text, /expinsider|policyLoaded|bash/);
});

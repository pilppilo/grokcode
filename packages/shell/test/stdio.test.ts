import assert from "node:assert/strict";
import test from "node:test";

import { createShellRuntime } from "../src/execute.ts";
import { createFrameParser, encodeFrame, handleStdioMessage, localBackend } from "../src/stdio.ts";

test("stdio framing emits NDJSON and recovers after malformed lines", () => {
  const seen: unknown[] = [];
  const errors: Error[] = [];
  const parser = createFrameParser((message) => seen.push(message), (err) => errors.push(err));
  const payload = { jsonrpc: "2.0", id: 1, method: "ping" };
  const frame = encodeFrame(payload);
  assert.equal(frame.toString(), JSON.stringify(payload) + "\n");
  parser(Buffer.from("\ninvalid\n  "));
  parser(frame.subarray(0, 10));
  assert.equal(seen.length, 0);
  parser(frame.subarray(10));
  parser(Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })}\n`));
  assert.equal(seen.length, 2);
  assert.equal(errors.length, 1);
  assert.deepEqual(seen[0], payload);
});

test("the stdio server lists shell tools and defaults the machine", async () => {
  const runtime = createShellRuntime({
    platform: "posix",
    home: "/tmp",
    loadPolicy: () => ({ policy: null, source: "(unset)", error: "no policy" }),
  });
  const backend = localBackend("my-pc", runtime);
  const listed = (await handleStdioMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" }, backend)) as {
    result: { tools: Array<{ name: string; description?: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }> };
  };
  const run = listed.result.tools.find((tool) => tool.name === "run_command");
  const machines = listed.result.tools.find((tool) => tool.name === "list_machines");
  const commit = listed.result.tools.find((tool) => tool.name === "git_commit_push");
  assert.equal(run?.annotations?.destructiveHint, true);
  assert.equal(machines?.annotations?.readOnlyHint, true);
  assert.match(commit?.description ?? "", /before anything is staged or committed/);
  assert.match(commit?.description ?? "", /commit SHA/);
  assert.match(commit?.description ?? "", /retry only the push/i);
  const info = (await handleStdioMessage(
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_machine_info", arguments: {} } },
    backend,
  )) as { result: { isError: boolean; content: Array<{ text: string }> } };
  assert.equal(info.result.isError, false);
  assert.match(info.result.content[0]!.text, /my-pc|policyLoaded|bash/);
});

test("stdio preserves large JSON tool results", async () => {
  const payload = { path: "/tmp/source.txt", content: "x".repeat(90_000) };
  const result = await handleStdioMessage(
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "read_file", arguments: { path: payload.path } } },
    {
      mode: "direct",
      listMachines: async () => [{ name: "local", connectedAt: 0 }],
      call: async () => payload,
    },
  ) as { result: { content: { text: string }[] } };
  assert.deepEqual(JSON.parse(result.result.content[0]!.text), payload);
});

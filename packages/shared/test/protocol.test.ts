import assert from "node:assert/strict";
import test from "node:test";

import { encodeMessage, parseMessage } from "../src/protocol.ts";
import { ToolError } from "../src/errors.ts";

test("rpc and result frames round-trip", () => {
  const frame = encodeMessage({ type: "rpc", id: "1", op: "get_session", params: { sessionId: "ses_1" } });
  assert.deepEqual(parseMessage(frame), {
    type: "rpc",
    id: "1",
    op: "get_session",
    params: { sessionId: "ses_1" },
  });
  const result = parseMessage(encodeMessage({ type: "result", id: "1", ok: true, data: { ok: 1 } }));
  assert.equal(result.type, "result");
  if (result.type === "result" && result.ok) assert.deepEqual(result.data, { ok: 1 });
});

test("unknown ops and garbage frames are rejected", () => {
  assert.throws(() => parseMessage(JSON.stringify({ type: "rpc", id: "1", op: "raw_http", params: {} })), ToolError);
  assert.throws(() => parseMessage("not-json"), ToolError);
  assert.throws(() => parseMessage(JSON.stringify({ type: "hello", protocol: 99 })), /protocol/);
});

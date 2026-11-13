import assert from "node:assert/strict";
import test from "node:test";

import { encodeMessage, encodeResultFrames, MAX_FRAME, parseChunkedResult, parseMessage } from "../src/protocol.ts";
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

test("oversized results are chunked under the frame limit and reassemble", () => {
  const data = { blob: `\u0000`.repeat(200_000), answer: "END" };
  const frames = encodeResultFrames("rpc_1", data);
  assert.ok(frames.length > 1);
  const pieces: Array<string | undefined> = new Array(frames.length);
  for (const frame of frames) {
    assert.ok(frame.length <= MAX_FRAME);
    const message = parseMessage(frame);
    assert.equal(message.type, "result");
    if (message.type !== "result" || !message.ok) continue;
    assert.equal(typeof message.data, "string");
    assert.equal(message.parts, frames.length);
    pieces[message.part ?? -1] = message.data as string;
  }
  assert.deepEqual(parseChunkedResult(pieces), data);
  assert.equal(encodeResultFrames("rpc_1", { ok: true }).length, 1);
  assert.throws(() => parseMessage("x".repeat(MAX_FRAME + 1)), /size limit/);
});

test("unknown ops and garbage frames are rejected", () => {
  assert.throws(() => parseMessage(JSON.stringify({ type: "rpc", id: "1", op: "raw_http", params: {} })), ToolError);
  assert.throws(() => parseMessage("not-json"), ToolError);
  assert.throws(() => parseMessage(JSON.stringify({ type: "hello", protocol: 99 })), /protocol/);
});

import assert from "node:assert/strict";
import test from "node:test";

import { executeOp } from "../src/executor.ts";
import {
  LIST_TEXT_MAX,
  projectMessageList,
  readMessage,
  sliceTextWindow,
  summarizeSession,
  truncateKeepEnd,
} from "../src/messages.ts";
import { OpenCodeClient } from "../src/opencode.ts";

const COMPLETED = Date.parse("2026-11-13T21:13:00Z");
const CREATED = Date.parse("2026-11-13T21:05:00Z");

function v2Turn() {
  return {
    id: "msg_a",
    type: "assistant",
    time: { created: CREATED, completed: COMPLETED },
    finish: "stop",
    content: [
      { type: "reasoning", text: `REASON_START${"r".repeat(160_000)}REASON_END` },
      {
        type: "tool",
        id: "call_1",
        name: "bash",
        state: {
          status: "completed",
          input: { command: "ls -la" },
          content: [{ type: "text", text: `OUT_START${"o".repeat(5_000)}OUT_END` }],
        },
      },
      { type: "text", text: "Working through it." },
      { type: "text", text: "The work is done. FINAL_ANSWER" },
    ],
  };
}

function v1Turn() {
  return {
    info: {
      id: "msg_v1",
      role: "assistant",
      time: { created: 1_000, completed: 2_000 },
      error: { name: "APIError", data: { message: "overloaded" } },
    },
    parts: [
      { type: "reasoning", text: `REASON_START${"r".repeat(8_000)}REASON_END` },
      {
        type: "tool",
        tool: "read",
        callID: "call_9",
        state: { status: "error", input: { path: "a.ts" }, error: "no such file" },
      },
      { type: "text", text: "Could not finish. FINAL_ANSWER" },
      { type: "step-finish", reason: "error" },
    ],
  };
}

test("truncation keeps the end of text and marks the cut", () => {
  const cut = truncateKeepEnd(`START${"z".repeat(1_000)}END`, 80);
  assert.equal(cut.truncated, true);
  assert.ok(cut.text.length <= 80);
  assert.ok(cut.text.endsWith("END"));
  assert.match(cut.text, /omitted \d+ characters from the start/);
  assert.equal(cut.text.includes("START"), false);
  assert.deepEqual(truncateKeepEnd("short", 80), { text: "short", truncated: false, omitted: 0 });
});

test("character windows can be walked from the start through the end", () => {
  const full = "0123456789".repeat(10);
  const chunks: string[] = [];
  let offset = 0;
  for (let guard = 0; guard < 20; guard++) {
    const window = sliceTextWindow(full, offset, 25);
    const body = window.text
      .replace(/^… omitted \d+ characters from the start …\n/, "")
      .replace(/\n… omitted \d+ characters from the end …$/, "");
    chunks.push(body);
    if (window.nextOffset == null) break;
    offset = window.nextOffset;
  }
  assert.equal(chunks.join(""), full);

  const tail = sliceTextWindow(full, undefined, 10);
  assert.equal(tail.text.endsWith("789"), true);
  assert.match(tail.text, /from the start/);
});

test("v2 assistant projection leads with the final answer and summarizes tools", () => {
  const listed = projectMessageList(
    [
      { id: "msg_u", type: "user", text: "go", time: { created: CREATED - 1_000 } },
      v2Turn(),
    ],
    { order: "desc" },
  );
  assert.equal(listed.order, "desc");
  assert.equal(listed.messages[0]?.id, "msg_a");
  assert.equal(listed.messages[0]?.role, "assistant");
  assert.match(listed.messages[0]?.text ?? "", /FINAL_ANSWER$/);
  assert.match(listed.messages[0]?.text ?? "", /Working through it/);
  assert.equal(listed.messages[0]?.text.includes("REASON_START"), false);
  assert.equal(listed.messages[0]?.reasoning, undefined);
  assert.equal(listed.messages[0]?.finish, "stop");
  assert.equal(listed.messages[0]?.completed, COMPLETED);
  const tool = listed.messages[0]?.tools?.[0];
  assert.equal(tool?.name, "bash");
  assert.equal(tool?.status, "completed");
  assert.equal(tool?.input, "ls -la");
  assert.match(tool?.output ?? "", /OUT_END$/);
  assert.equal(tool?.output?.includes("OUT_START"), false);
  assert.equal(tool?.outputTruncated, true);
  assert.equal(listed.latest?.text.endsWith("FINAL_ANSWER"), true);
  assert.equal(JSON.stringify(listed).includes("REASON_START"), false);
  assert.ok(JSON.stringify(listed).endsWith('FINAL_ANSWER"}}'));
});

test("v1 parts keep the final text, finish reason, and error", () => {
  const listed = projectMessageList([v1Turn()]);
  const message = listed.messages[0];
  assert.equal(message?.role, "assistant");
  assert.equal(message?.text, "Could not finish. FINAL_ANSWER");
  assert.equal(message?.finish, "error");
  assert.equal(message?.error, "APIError: overloaded");
  assert.equal(message?.tools?.[0]?.name, "read");
  assert.equal(message?.tools?.[0]?.status, "error");
  assert.equal(message?.tools?.[0]?.input, "a.ts");
  assert.match(message?.tools?.[0]?.error ?? "", /no such file/);
  assert.equal(JSON.stringify(message).includes("REASON_START"), false);
});

test("includeReasoning keeps the end of reasoning and full tool output can be requested", () => {
  const listed = projectMessageList([v2Turn()], { includeReasoning: true, includeToolOutput: "full" });
  assert.match(listed.messages[0]?.reasoning ?? "", /REASON_END$/);
  assert.equal(listed.messages[0]?.reasoning?.includes("REASON_START"), false);
  assert.equal(listed.messages[0]?.reasoningTruncated, true);
  const hidden = projectMessageList([v2Turn()], { includeToolOutput: "none" });
  assert.equal(hidden.messages[0]?.tools?.[0]?.output, undefined);
  assert.equal(hidden.messages[0]?.tools?.[0]?.name, "bash");
});

test("order, limit, and tail select the newest or oldest messages", () => {
  const raws = [1, 2, 3].map((n) => ({ id: `m${n}`, type: "user", text: String(n), time: { created: n } }));
  assert.deepEqual(
    projectMessageList(raws, { order: "desc", limit: 2 }).messages.map((message) => message.id),
    ["m3", "m2"],
  );
  assert.deepEqual(
    projectMessageList(raws, { order: "asc", limit: 2 }).messages.map((message) => message.id),
    ["m1", "m2"],
  );
  assert.deepEqual(
    projectMessageList(raws, { order: "asc", tail: 1 }).messages.map((message) => message.id),
    ["m3"],
  );
  const untimed = projectMessageList([
    { id: "old", type: "user", text: "old" },
    { id: "new", type: "assistant", parts: [{ type: "text", text: "new answer" }] },
  ]);
  assert.equal(untimed.messages[0]?.id, "new");
  assert.equal(untimed.latest?.text, "new answer");
});

test("a long final answer keeps its end and the latest tools stay in the list", () => {
  const huge = `START${"a".repeat(LIST_TEXT_MAX + 5_000)}FINAL_ANSWER`;
  const tools = Array.from({ length: 50 }, (_, index) => ({
    type: "tool",
    name: `tool_${index}`,
    state: { status: "completed", input: { command: `cmd ${index}` }, output: "ok" },
  }));
  const listed = projectMessageList([
    { id: "m", type: "assistant", content: [...tools, { type: "text", text: huge }] },
  ]);
  assert.ok(listed.messages[0]?.text.endsWith("FINAL_ANSWER"));
  assert.equal(listed.messages[0]?.text.includes("START"), false);
  assert.equal(listed.messages[0]?.textTruncated, true);
  assert.equal(listed.hint?.includes("get_message"), true);
  assert.equal(listed.messages[0]?.toolCount, 50);
  assert.equal(listed.messages[0]?.toolsOmitted, 10);
  assert.equal(listed.messages[0]?.tools?.[0]?.name, "tool_10");
  assert.equal(listed.messages[0]?.tools?.at(-1)?.name, "tool_49");
  assert.equal(listed.latest?.tools?.at(-1)?.name, "tool_49");
  assert.equal(listed.latest?.tools?.length, 8);
});

test("get_message pages parts from the end and characters from either side", () => {
  const content = Array.from({ length: 10 }, (_, index) => ({ type: "text", text: `part-${index}` }));
  content.unshift({ type: "reasoning", text: "hidden-thought" });
  const page = readMessage({ id: "m", type: "assistant", content }, { partLimit: 3 });
  assert.deepEqual(
    page.parts.map((part) => part.text),
    ["part-7", "part-8", "part-9"],
  );
  assert.equal(page.partCount, 10);
  assert.equal(page.prevPartOffset, 4);
  assert.equal(JSON.stringify(page).includes("hidden-thought"), false);

  const first = readMessage({ id: "m", type: "assistant", content }, { partOffset: 0, partLimit: 3 });
  assert.deepEqual(
    first.parts.map((part) => part.text),
    ["part-0", "part-1", "part-2"],
  );
  assert.equal(first.nextPartOffset, 3);

  const reasoning = readMessage({ id: "m", type: "assistant", content }, { includeReasoning: true, partOffset: 0, partLimit: 1 });
  assert.equal(reasoning.parts[0]?.type, "reasoning");
  assert.equal(reasoning.parts[0]?.text, "hidden-thought");

  const text = `START${"b".repeat(500)}END`;
  const tail = readMessage({ id: "m", type: "assistant", content: [{ type: "text", text }] }, { maxChars: 40 });
  assert.ok(tail.text.endsWith("END"));
  assert.match(tail.text, /from the start/);
  assert.equal(tail.text.includes("START"), false);
  const head = readMessage(
    { id: "m", type: "assistant", content: [{ type: "text", text }] },
    { offset: 0, maxChars: 40 },
  );
  assert.ok(head.text.startsWith("START"));
  assert.match(head.text, /from the end/);
  assert.equal(head.nextTextOffset, 40);
});

test("session summary reports status, last activity, final text, and the last tools", () => {
  const idleAt = COMPLETED + 5_000;
  const state = summarizeSession(
    { id: "ses_1", title: "fix", directory: "/work", activity: "idle", raw: { time: { updated: CREATED } } },
    [v2Turn(), { id: "idle_1", type: "idle", outcome: "succeeded", time: { created: idleAt } }],
  );
  assert.equal(state.status, "idle");
  assert.equal(state.lastActivity, idleAt);
  assert.equal(state.messageId, "msg_a");
  assert.equal(state.finish, "stop");
  assert.equal(state.outcome, "succeeded");
  assert.ok(state.text.endsWith("FINAL_ANSWER"));
  assert.equal(state.text.includes("REASON_START"), false);
  assert.equal(state.tools?.[0]?.name, "bash");
  assert.equal(state.tools?.[0]?.status, "completed");
  assert.ok(JSON.stringify(state).endsWith('FINAL_ANSWER"}'));
});

test("executor serves v2 and v1 final state through get_messages, get_message, and get_session_summary", async () => {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(`${url.pathname}?${url.searchParams.toString()}`);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (url.pathname === "/api/session/ses_1") {
      return json({ data: { id: "ses_1", title: "fix", location: { directory: "/work" }, time: { updated: CREATED } } });
    }
    if (url.pathname === "/api/session/active") return json({ data: {} });
    if (url.pathname === "/api/session/ses_1/message/msg_a") return json({ data: v2Turn() });
    if (url.pathname === "/api/session/ses_1/message") {
      return json({ data: [{ id: "msg_u", type: "user", text: "go", time: { created: CREATED - 10 } }, v2Turn()], cursor: {} });
    }
    if (url.pathname === "/session/ses_v1") return json({ id: "ses_v1", directory: "/work", time: { updated: 2_000 } });
    if (url.pathname === "/session/status") return json({});
    if (url.pathname === "/session/ses_v1/message/msg_v1") return json(v1Turn());
    if (url.pathname === "/session/ses_v1/message") return json([v1Turn()]);
    return json({ message: "missing" }, 404);
  };

  const v2 = new OpenCodeClient({ baseUrl: "http://127.0.0.1:4096", api: "v2", fetch: fetchImpl });
  const ctx2 = { api: v2, allowDirs: ["/work"], platform: "posix" as const, home: "/home/ada" };
  const listed = (await executeOp(ctx2, "get_messages", { sessionId: "ses_1", includeReasoning: false })) as {
    messages: { text: string; tools?: { name: string }[] }[];
    latest: { text: string; finish: string };
  };
  assert.ok(listed.latest.text.endsWith("FINAL_ANSWER"));
  assert.equal(listed.latest.finish, "stop");
  assert.equal(listed.messages[0]?.tools?.[0]?.name, "bash");
  assert.equal(JSON.stringify(listed).includes("REASON_START"), false);
  assert.ok(calls.some((call) => call.includes("/api/session/ses_1/message?") && call.includes("order=desc")));

  const page = (await executeOp(ctx2, "get_message", {
    sessionId: "ses_1",
    messageId: "msg_a",
    maxChars: 32,
  })) as { text: string; textTotal: number };
  assert.ok(page.text.endsWith("FINAL_ANSWER"));
  assert.match(page.text, /from the start/);
  assert.ok(page.textTotal > 32);

  const summary = (await executeOp(ctx2, "get_session_summary", { sessionId: "ses_1" })) as {
    status: string;
    text: string;
    finish: string;
    lastActivity: number;
  };
  assert.equal(summary.status, "idle");
  assert.equal(summary.finish, "stop");
  assert.ok(summary.text.endsWith("FINAL_ANSWER"));
  assert.equal(summary.lastActivity, COMPLETED);
  assert.ok(calls.some((call) => call.includes("type=assistant")));

  const v1 = new OpenCodeClient({ baseUrl: "http://127.0.0.1:4096", api: "v1", fetch: fetchImpl });
  const ctx1 = { api: v1, allowDirs: ["/work"], platform: "posix" as const, home: "/home/ada" };
  const v1Listed = (await executeOp(ctx1, "get_messages", { sessionId: "ses_v1", order: "asc" })) as {
    messages: { text: string; error?: string; finish?: string }[];
  };
  assert.equal(v1Listed.messages[0]?.text, "Could not finish. FINAL_ANSWER");
  assert.equal(v1Listed.messages[0]?.error, "APIError: overloaded");
  assert.equal(v1Listed.messages[0]?.finish, "error");
  const v1Page = (await executeOp(ctx1, "get_message", { sessionId: "ses_v1", messageId: "msg_v1" })) as {
    text: string;
    tools?: { name: string; status?: string }[];
  };
  assert.equal(v1Page.text, "Could not finish. FINAL_ANSWER");
  assert.equal(v1Page.tools?.[0]?.name, "read");
  assert.equal(v1Page.tools?.[0]?.status, "error");
  const v1Summary = (await executeOp(ctx1, "get_session_summary", { sessionId: "ses_v1" })) as { text: string; error?: string };
  assert.ok(v1Summary.text.endsWith("FINAL_ANSWER"));
  assert.equal(v1Summary.error, "APIError: overloaded");

  await assert.rejects(() => executeOp(ctx2, "get_messages", { sessionId: "ses_1", order: "sideways" }), /order/);
});

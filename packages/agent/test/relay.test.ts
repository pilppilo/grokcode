import assert from "node:assert/strict";
import test from "node:test";

import { encodeMessage, parseMessage } from "grokcode-shared";

import { runRelayConnection, type RelaySocket } from "../src/relay.ts";

class FakeSocket implements RelaySocket {
  readyState = 0;
  sent: string[] = [];
  private listeners = new Map<string, Set<(...args: never[]) => void>>();

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
    this.emit("close");
  }
  on(event: "open" | "message" | "close" | "error", listener: (...args: never[]) => void): void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener);
    this.listeners.set(event, set);
  }
  once(event: "open" | "error", listener: (...args: never[]) => void): void {
    const wrapped = ((...args: never[]) => {
      this.listeners.get(event)?.delete(wrapped as never);
      listener(...args);
    }) as (...args: never[]) => void;
    this.on(event, wrapped);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...(args as never[]));
  }
}

test("relay client authenticates, answers rpc, and does not put the token in frames", async () => {
  const ac = new AbortController();
  let socket!: FakeSocket;
  const headers: Record<string, string>[] = [];
  const done = runRelayConnection({
    url: "ws://relay.example/agent",
    name: "laptop",
    token: "machine-token-0123456789abcd",
    signal: ac.signal,
    opencode: { api: "v2", version: "2.2.1" },
    execute: async (op, params) => ({ op, params }),
    connect: (_url, requestHeaders) => {
      headers.push(requestHeaders);
      socket = new FakeSocket();
      queueMicrotask(() => {
        socket.readyState = 1;
        socket.emit("open");
      });
      return socket;
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(headers[0]?.Authorization, "Bearer machine-token-0123456789abcd");
  assert.equal(headers[0]?.["X-Grokcode-Machine"], "laptop");
  const hello = parseMessage(socket.sent[0] ?? "");
  assert.equal(hello.type, "hello");
  assert.equal(JSON.stringify(socket.sent).includes("machine-token"), false);

  socket.emit(
    "message",
    encodeMessage({ type: "rpc", id: "abc", op: "get_session", params: { sessionId: "ses_1" } }),
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  const result = parseMessage(socket.sent.at(-1) ?? "");
  assert.equal(result.type, "result");
  if (result.type === "result" && result.ok) {
    assert.deepEqual(result.data, { op: "get_session", params: { sessionId: "ses_1" } });
  } else {
    assert.fail("expected a successful result");
  }

  socket.close();
  await done;
  ac.abort();
});

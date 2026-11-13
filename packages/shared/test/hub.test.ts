import assert from "node:assert/strict";
import test from "node:test";

import { RelayHub, type SocketLike } from "../src/hub.ts";
import { encodeMessage, encodeResultFrames, MAX_FRAME, parseMessage } from "../src/protocol.ts";

class FakeSocket implements SocketLike {
  sent: string[] = [];
  closed: { code?: number; reason?: string } | null = null;
  constructor(private readonly onSend?: (raw: string) => void) {}
  send(data: string): void {
    this.sent.push(data);
    this.onSend?.(data);
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }
}

test("routes an rpc to the named machine and correlates the result", async () => {
  const hub = new RelayHub();
  const laptop = new FakeSocket((raw) => {
    const msg = parseMessage(raw);
    if (msg.type !== "rpc") return;
    hub.handleSocketMessage(
      "laptop",
      encodeMessage({ type: "result", id: msg.id, ok: true, data: { echo: msg.params } }),
    );
  });
  hub.attach("laptop", laptop);
  const data = await hub.call("laptop", "server_info", { ping: true }, 1000);
  assert.deepEqual(data, { echo: { ping: true } });
  assert.deepEqual(
    hub.list().map((machine) => machine.name),
    ["laptop"],
  );
});

test("offline machines fail and a replacement does not drop the new socket", async () => {
  const hub = new RelayHub({ callTimeoutMs: 30 });
  await assert.rejects(hub.call("laptop", "server_info", {}, 20), /not connected/);

  const first = new FakeSocket();
  const second = new FakeSocket();
  hub.attach("laptop", first);
  hub.attach("laptop", second);
  assert.equal(first.closed?.code, 4001);
  hub.detach("laptop", first);
  assert.equal(hub.has("laptop"), true);
  hub.detach("laptop", second);
  assert.equal(hub.has("laptop"), false);
});

test("times out a call the agent never answers", async () => {
  const hub = new RelayHub();
  hub.attach("laptop", new FakeSocket());
  await assert.rejects(hub.call("laptop", "get_session", { sessionId: "ses_1" }, 20), /timed out/);
});

test("reassembles chunked results even when the frames arrive out of order", async () => {
  const hub = new RelayHub();
  const payload = { answer: "END", blob: "q".repeat(1_000_000) };
  const socket = new FakeSocket((raw) => {
    const msg = parseMessage(raw);
    if (msg.type !== "rpc") return;
    const frames = encodeResultFrames(msg.id, payload).reverse();
    for (const frame of frames) hub.handleSocketMessage("laptop", frame);
  });
  hub.attach("laptop", socket);
  const data = (await hub.call("laptop", "server_info", {}, 2_000)) as { answer: string; blob: string };
  assert.equal(data.answer, "END");
  assert.equal(data.blob.length, 1_000_000);
});

test("an oversized frame fails the call instead of being ignored", async () => {
  const hub = new RelayHub();
  let rpcId = "";
  const socket = new FakeSocket((raw) => {
    const msg = parseMessage(raw);
    if (msg.type === "rpc") rpcId = msg.id;
  });
  hub.attach("laptop", socket);
  const pending = hub.call("laptop", "server_info", {}, 2_000);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const huge = `{"type":"result","id":"${rpcId}","ok":true,"data":"${"x".repeat(MAX_FRAME)}"}`;
  hub.handleSocketMessage("laptop", huge);
  await assert.rejects(pending, /size limit/);
});

test("hello updates version metadata and ping is answered", () => {
  const hub = new RelayHub();
  const socket = new FakeSocket();
  hub.attach("laptop", socket);
  hub.handleSocketMessage(
    "laptop",
    encodeMessage({ type: "hello", protocol: 1, opencode: { api: "v2", version: "2.2.0" } }),
  );
  assert.equal(hub.list()[0]?.version, "2.2.0");
  assert.equal(hub.list()[0]?.api, "v2");
  hub.handleSocketMessage("laptop", encodeMessage({ type: "ping", t: 5 }));
  const pong = parseMessage(socket.sent.at(-1) ?? "");
  assert.deepEqual(pong, { type: "pong", t: 5 });
});

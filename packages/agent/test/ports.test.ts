import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";

import { inodeFromProcNet, ipv4ToProc, listeningPid, parseLsofPids, parseNetstatPid } from "../src/ports.ts";

test("proc net and netstat parsers find the listener for a loopback port", () => {
  assert.equal(ipv4ToProc("127.0.0.1"), "0100007F");
  const proc = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n" +
    "   0: 0100007F:1000 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 4242 1 00000000 100 0 0 10 0\n";
  assert.equal(inodeFromProcNet(proc, 4096, "127.0.0.1"), "4242");
  assert.equal(inodeFromProcNet(proc, 4096, "10.0.0.8"), undefined);

  const netstat = [
    "  Proto  Local Address          Foreign Address        State           PID",
    "  TCP    127.0.0.1:4096         0.0.0.0:0              LISTENING       99",
    "  TCP    0.0.0.0:80             0.0.0.0:0              LISTENING       4",
  ].join("\n");
  assert.equal(parseNetstatPid(netstat, 4096, "127.0.0.1"), 99);
  assert.equal(parseLsofPids("\n4242\n"), 4242);
});

test("listeningPid sees a loopback server on this machine", async () => {
  if (process.platform !== "linux") return;
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    assert.equal(await listeningPid("127.0.0.1", port), process.pid);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

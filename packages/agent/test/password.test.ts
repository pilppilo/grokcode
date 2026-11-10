import assert from "node:assert/strict";
import test from "node:test";

import { redactSecrets, scanServerPassword } from "../src/password.ts";
import { buildServeArgs, supervise } from "../src/supervisor.ts";

test("serve args and password scraping", () => {
  assert.deepEqual(buildServeArgs("127.0.0.1", 4096), ["serve", "--hostname", "127.0.0.1", "--port", "4096"]);
  assert.equal(scanServerPassword("server password generated-password-value"), "generated-password-value");
  assert.equal(scanServerPassword("Server Password: hunter2."), "hunter2");
  assert.equal(scanServerPassword("listening"), null);
  assert.equal(redactSecrets("server password hunter2"), "server password [redacted]");
  assert.doesNotMatch(redactSecrets("server password hunter2"), /hunter2/);
});

test("supervisor captures a generated password and can be stopped", async () => {
  const script = "console.log('server password generated-password-value'); setInterval(() => {}, 1000);";
  const supervised = await supervise({
    command: process.execPath,
    args: ["-e", script],
    env: { ...process.env },
    readyTimeoutMs: 5000,
    log: () => {},
    probe: async (password) => (password === "generated-password-value" ? "up" : "down"),
  });
  assert.equal(supervised.password(), "generated-password-value");
  await supervised.stop();
});

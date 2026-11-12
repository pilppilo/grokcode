import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig, parseListen, relayWebSocketUrl, validateConfig } from "../src/config.ts";

const TOKEN = "machine-token-0123456789abcd";
const MCP = "mcp-token-0123456789abcdef";

test("relay URLs gain the /agent path and the right scheme", () => {
  assert.equal(relayWebSocketUrl("https://example.test"), "wss://example.test/agent");
  assert.equal(relayWebSocketUrl("http://127.0.0.1:8787/agent"), "ws://127.0.0.1:8787/agent");
  assert.equal(relayWebSocketUrl("wss://example.test/agent"), "wss://example.test/agent");
});

test("listen accepts a port, host:port, and bracketed ipv6", () => {
  assert.deepEqual(parseListen("8788"), { host: "127.0.0.1", port: 8788 });
  assert.deepEqual(parseListen("0.0.0.0:8788"), { host: "0.0.0.0", port: 8788 });
  assert.deepEqual(parseListen("[::1]:8788"), { host: "::1", port: 8788 });
});

test("CLI flags beat the environment, and relay mode requires a long token", () => {
  const config = loadConfig(
    ["--name", "laptop", "--relay", "https://example.test", "--token", TOKEN, "--no-spawn", "--opencode-url", "http://127.0.0.1:4096"],
    { GROKCODE_MACHINE_NAME: "other", OPENCODE_PASSWORD: "pw", OPENCODE_SERVER_USERNAME: "opencode" },
  );
  assert.equal(config.name, "laptop");
  assert.equal(config.relay, "wss://example.test/agent");
  assert.equal(config.spawn, false);
  assert.equal(config.password, "pw");
  assert.doesNotThrow(() => validateConfig(config));

  const missing = loadConfig(["--name", "laptop", "--relay", "wss://example.test/agent"], {});
  assert.throws(() => validateConfig(missing), /token/);
});

test("direct mode requires an MCP token and can run without a relay", () => {
  const config = loadConfig(["--listen", "127.0.0.1:8788", "--mcp-token", MCP, "--no-spawn"], {});
  assert.equal(config.relay, undefined);
  assert.equal(config.name, "local");
  assert.doesNotThrow(() => validateConfig(config));
  assert.throws(() => validateConfig(loadConfig(["--listen", "8788"], {})), /MCP bearer/);
  assert.throws(() => validateConfig(loadConfig([], {})), /--relay/);
});

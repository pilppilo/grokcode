import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConfig, parseListen, relayWebSocketUrl, validateConfig } from "../src/config.ts";

const TOKEN = "machine-token-0123456789abcd";
const MCP = "mcp-token-0123456789abcdef";
const OTHER = "other-token-0123456789abcdef";

function tempHome(): string {
  return mkdtempSync(path.join(tmpdir(), "grokcode-cfg-"));
}

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
  assert.equal(config.opencodeMode, "attach");
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

test("default config files load from the home directory and real env vars win", () => {
  const home = tempHome();
  const dir = path.join(home, ".config", "grokcode");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "agent.json"),
    JSON.stringify({
      name: "from-json",
      relay: "wss://json.example/agent",
      token: TOKEN,
      defaultModel: "file/json-model",
      allowDirs: ["/from/json"],
    }),
  );
  writeFileSync(
    path.join(dir, "agent.env"),
    [
      "GROKCODE_MACHINE_NAME=from-env-file",
      "GROKCODE_RELAY_URL=wss://env-file.example/agent",
      "GROKCODE_MACHINE_TOKEN=" + TOKEN,
      "OPENCODE_PASSWORD=from-file",
      "GROKCODE_DEFAULT_MODEL=opencode-go/deepseek-v4.1-flash",
      "GROKCODE_ALLOW_DIRS=/from/env",
      "# comment",
      "export GROKCODE_OPENCODE_MODE=auto",
    ].join("\n"),
  );

  const config = loadConfig([], {
    HOME: home,
    USERPROFILE: home,
    GROKCODE_MACHINE_TOKEN: OTHER,
    GROKCODE_MACHINE_NAME: "from-process-env",
  });
  assert.equal(config.name, "from-process-env");
  assert.equal(config.token, OTHER);
  assert.equal(config.relay, "wss://env-file.example/agent");
  assert.equal(config.password, "from-file");
  assert.equal(config.defaultModel, "opencode-go/deepseek-v4.1-flash");
  assert.equal(config.opencodeMode, "auto");
  assert.deepEqual(config.allowDirs, ["/from/json", "/from/env"]);
  assert.equal(config.loadedFrom.length, 2);
  assert.doesNotThrow(() => validateConfig(config));

  const flagged = loadConfig(["--default-model", "cli/model", "--token", TOKEN], {
    HOME: home,
    USERPROFILE: home,
    GROKCODE_DEFAULT_MODEL: "env/model",
    GROKCODE_RELAY_URL: "https://cli.example",
  });
  assert.equal(flagged.defaultModel, "cli/model");
  assert.equal(flagged.name, "from-env-file");
  assert.equal(flagged.token, TOKEN);
});

test("--config and GROKCODE_CONFIG select an explicit file", () => {
  const home = tempHome();
  const file = path.join(home, "custom.env");
  writeFileSync(file, `GROKCODE_MACHINE_NAME=desktop\nGROKCODE_RELAY_URL=wss://custom.example/agent\nGROKCODE_MACHINE_TOKEN=${TOKEN}\n`);
  const fromEnv = loadConfig([], { GROKCODE_CONFIG: file, HOME: home });
  assert.equal(fromEnv.name, "desktop");
  assert.deepEqual(fromEnv.loadedFrom, [file]);

  const json = path.join(home, "agent.json");
  writeFileSync(json, JSON.stringify({ name: "json-box", listen: "127.0.0.1:8788", mcpToken: MCP, password: "secret" }));
  const fromFlag = loadConfig(["--config", json, "--no-spawn"], { HOME: home, GROKCODE_CONFIG: file });
  assert.equal(fromFlag.name, "json-box");
  assert.equal(fromFlag.password, "secret");
  assert.equal(fromFlag.opencodeMode, "attach");
  assert.doesNotThrow(() => validateConfig(fromFlag));
  assert.throws(() => loadConfig(["--config", path.join(home, "missing.env")], {}), /not found/);
});

test("default model and opencode mode are validated", () => {
  const home = tempHome();
  const config = loadConfig(["--relay", "wss://example.test/agent", "--token", TOKEN, "--default-model", "opencode-go/deepseek-v4.1-flash"], {
    HOME: home,
  });
  assert.equal(config.opencodeMode, "attach");
  assert.equal(config.spawn, false);
  assert.doesNotThrow(() => validateConfig(config));
  assert.throws(
    () => validateConfig(loadConfig(["--relay", "wss://example.test/agent", "--token", TOKEN, "--default-model", "noslash"], {})),
    /provider\/model/,
  );
  assert.throws(() => loadConfig(["--opencode-mode", "sideways"], {}), /auto, attach, or spawn/);
  const opted = loadConfig(
    ["--relay", "wss://example.test/agent", "--token", TOKEN, "--opencode-mode", "auto"],
    { HOME: home },
  );
  assert.equal(opted.opencodeMode, "auto");
  assert.equal(opted.spawn, true);
  const spawned = loadConfig(["--relay", "wss://example.test/agent", "--token", TOKEN, "--spawn"], { HOME: home });
  assert.equal(spawned.opencodeMode, "spawn");
});

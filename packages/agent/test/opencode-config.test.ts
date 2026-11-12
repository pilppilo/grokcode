import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveOpenCodeConfigPath, upsertOpenCodeModel, writeOpenCodeDefaultModel } from "../src/opencode-config.ts";
import { mergeAgentEnv, parseEnvFile } from "../src/envfile.ts";
import { writeAgentEnvFile } from "../src/write-config.ts";

const TOKEN = "machine-token-0123456789abcd";

test("env files keep quotes, exports, and comments out of values", () => {
  const parsed = parseEnvFile(`
# comment
export GROKCODE_MACHINE_NAME="desk top"
OPENCODE_PASSWORD='keep me'
GROKCODE_RELAY_URL=wss://example.test/agent # note
`);
  assert.equal(parsed.GROKCODE_MACHINE_NAME, "desk top");
  assert.equal(parsed.OPENCODE_PASSWORD, "keep me");
  assert.equal(parsed.GROKCODE_RELAY_URL, "wss://example.test/agent");
});

test("merging an agent env file updates given keys and keeps the password", () => {
  const existing = "GROKCODE_MACHINE_NAME=old\nOPENCODE_PASSWORD=secret-value\nCUSTOM_FLAG=1\n";
  const merged = mergeAgentEnv(existing, {
    GROKCODE_MACHINE_NAME: "desktop",
    GROKCODE_MACHINE_TOKEN: TOKEN,
    OPENCODE_PASSWORD: undefined,
    GROKCODE_DEFAULT_MODEL: "",
  });
  const parsed = parseEnvFile(merged);
  assert.equal(parsed.GROKCODE_MACHINE_NAME, "desktop");
  assert.equal(parsed.GROKCODE_MACHINE_TOKEN, TOKEN);
  assert.equal(parsed.OPENCODE_PASSWORD, "secret-value");
  assert.equal(parsed.CUSTOM_FLAG, "1");
  assert.equal(parsed.GROKCODE_DEFAULT_MODEL, undefined);
  assert.doesNotMatch(merged, /undefined/);
});

test("writing a new agent env generates a password and limits permissions", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "grokcode-env-"));
  const file = path.join(dir, "agent.env");
  const result = writeAgentEnvFile(file, {
    GROKCODE_MACHINE_NAME: "desktop",
    GROKCODE_RELAY_URL: "wss://example.test/agent",
    GROKCODE_MACHINE_TOKEN: TOKEN,
    GROKCODE_DEFAULT_MODEL: "opencode-go/deepseek-v4.1-flash",
  });
  assert.equal(result.password, "generated");
  const parsed = parseEnvFile(readFileSync(file, "utf8"));
  assert.equal(parsed.GROKCODE_MACHINE_NAME, "desktop");
  assert.equal(parsed.GROKCODE_DEFAULT_MODEL, "opencode-go/deepseek-v4.1-flash");
  assert.match(parsed.OPENCODE_PASSWORD ?? "", /^[a-f0-9]{64}$/);
  if (process.platform !== "win32") {
    assert.equal(statSync(file).mode & 0o777, 0o600);
  }
  const again = writeAgentEnvFile(file, { GROKCODE_MACHINE_NAME: "desktop-2" });
  assert.equal(again.password, "kept");
  assert.equal(parseEnvFile(readFileSync(file, "utf8")).OPENCODE_PASSWORD, parsed.OPENCODE_PASSWORD);
  assert.throws(() => writeAgentEnvFile(file, { GROKCODE_MACHINE_TOKEN: "short" }), /at least/);
});

test("OpenCode config gains a model without dropping other settings", () => {
  const updated = upsertOpenCodeModel(
    JSON.stringify({ $schema: "https://opencode.ai/config.json", username: "ada", permissions: [{ action: "shell" }] }, null, 2),
    "opencode-go/deepseek-v4.1-flash",
  );
  const parsed = JSON.parse(updated) as { model: string; username: string; permissions: unknown[] };
  assert.equal(parsed.model, "opencode-go/deepseek-v4.1-flash");
  assert.equal(parsed.username, "ada");
  assert.equal(parsed.permissions.length, 1);

  const jsonc = `{
  "$schema": "https://opencode.ai/config.json",
  // keep this comment
  "username": "ada",
  "providers": { "model": "not-the-root" },
}`;
  const edited = upsertOpenCodeModel(jsonc, "opencode-go/deepseek-v4.1-flash");
  assert.match(edited, /keep this comment/);
  assert.match(edited, /"username": "ada"/);
  assert.match(edited, /"model": "not-the-root"/);
  assert.match(edited, /"model": "opencode-go\/deepseek-v4.1-flash"/);

  const replaced = upsertOpenCodeModel(`{\n  "model": "google/gemini",\n  "username": "ada",\n}\n`, "other/model");
  assert.match(replaced, /"model": "other\/model"/);
  assert.match(replaced, /"username": "ada"/);
  assert.doesNotMatch(replaced, /gemini/);
});

test("the OpenCode writer prefers jsonc when that is the file on disk", () => {
  const home = mkdtempSync(path.join(tmpdir(), "grokcode-oc-"));
  const dir = path.join(home, ".config", "opencode");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "opencode.jsonc"), `{
  // existing
  "username": "ada",
}\n`);
  const chosen = resolveOpenCodeConfigPath(home);
  assert.equal(chosen.exists, true);
  assert.equal(path.basename(chosen.file), "opencode.jsonc");
  const written = writeOpenCodeDefaultModel(home, "opencode-go/deepseek-v4.1-flash");
  const text = readFileSync(written, "utf8");
  assert.match(text, /existing/);
  assert.match(text, /opencode-go\/deepseek-v4.1-flash/);
  assert.match(text, /"username": "ada"/);
});

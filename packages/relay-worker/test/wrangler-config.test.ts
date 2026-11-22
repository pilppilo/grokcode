import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { findSecretVars, secretVarCollisions, WORKER_SECRET_NAMES } from "../scripts/assert-no-secret-vars.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");
const repoRoot = path.resolve(here, "../../..");
const workflowPath = path.join(repoRoot, ".github/workflows/deploy-relay.yml");

const DEPLOY_PATHS = [
  "packages/relay-worker/**",
  "packages/shared/**",
  "packages/shell/**",
  "package.json",
  "package-lock.json",
  "tsconfig.base.json",
  ".github/workflows/deploy-relay.yml",
];

test("worker secret names include the relay credentials", () => {
  for (const name of ["MCP_TOKEN", "MACHINE_TOKENS", "OWNER_APPROVAL_SECRET", "OWNER_EMAILS"]) {
    assert.ok(WORKER_SECRET_NAMES.includes(name), name);
  }
});

test("the relay wrangler config does not declare worker secrets as vars", async () => {
  const result = await secretVarCollisions(packageRoot);
  assert.deepEqual(result.files, ["wrangler.toml"]);
  assert.deepEqual(result.hits, []);
});

test("vars comments and the non-secret log level are allowed", () => {
  const hits = findSecretVars(
    "wrangler.toml",
    `
# wrangler secret put MCP_TOKEN
[vars]
# OWNER_EMAILS = "you@gmail.com"
LOG_LEVEL = "info" # MACHINE_TOKENS stays a secret
`,
  );
  assert.deepEqual(hits, []);
});

test("a plain var replaces a worker secret, including named environments and inline tables", () => {
  const toml = findSecretVars(
    "wrangler.toml",
    `
[vars]
MCP_TOKEN="from-vars"
LOG_LEVEL = "info"

[env.production.vars]
OWNER_EMAILS = "you@gmail.com"

[env.staging]
vars = { MACHINE_TOKENS = "{\\"laptop\\":\\"abcdef0123456789\\"}", LOG_LEVEL = "debug" }
`,
  );
  assert.deepEqual(
    toml.map((hit) => `${hit.section}:${hit.name}`),
    ["vars:MCP_TOKEN", "env.production.vars:OWNER_EMAILS", "vars:MACHINE_TOKENS"],
  );
});

test("jsonc vars are checked and comments are ignored", () => {
  const hits = findSecretVars(
    "wrangler.jsonc",
    `{
      // MCP_TOKEN is a secret, not a var
      "name": "grokcode-relay",
      "vars": { "LOG_LEVEL": "info", "PUBLIC_ORIGIN": "https://example.com" },
      "env": { "production": { "vars": { "OWNER_APPROVAL_SECRET": "0123456789abcdef" } } },
      "durable_objects": { "bindings": [{ "name": "HUB", "class_name": "RelayHubDO" }] }
    }`,
  );
  assert.deepEqual(
    hits.map((hit) => hit.name).sort(),
    ["OWNER_APPROVAL_SECRET", "PUBLIC_ORIGIN"],
  );
});

test("a directory with two wrangler configs is refused", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "grokcode-wrangler-"));
  try {
    await writeFile(path.join(directory, "wrangler.toml"), 'name = "grokcode-relay"\n');
    await writeFile(path.join(directory, "wrangler.jsonc"), '{ "name": "grokcode-relay" }\n');
    await assert.rejects(secretVarCollisions(directory), /single Wrangler config/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the config check exits 0 for this package", () => {
  const result = spawnSync(process.execPath, [path.join(packageRoot, "scripts/assert-no-secret-vars.mjs")], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
});

test("the deploy workflow publishes only after tests and does not upload worker secrets", async () => {
  const yaml = await readFile(workflowPath, "utf8");
  const executable = yaml
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");

  assert.match(yaml, /workflow_dispatch:/);
  assert.match(yaml, /branches:\s*\n\s*- main/);
  assert.match(yaml, /permissions:\s*\n\s*contents: read/);
  assert.match(yaml, /group: grokcode-relay-deploy/);
  assert.match(yaml, /cancel-in-progress: false/);
  assert.match(yaml, /environment: production/);
  assert.match(executable, /npm ci/);
  assert.match(executable, /npm test/);
  assert.match(executable, /npm run typecheck/);
  assert.match(executable, /npx --no-install wrangler deploy/);
  assert.doesNotMatch(executable, /secret put/);
  assert.doesNotMatch(executable, /--secrets-file/);
  assert.doesNotMatch(executable, /\n\s*secrets:/);
  for (const name of ["MCP_TOKEN", "MACHINE_TOKENS", "OWNER_APPROVAL_SECRET", "OWNER_EMAILS"]) {
    assert.equal(executable.includes(name), false, name);
  }
  for (const pattern of DEPLOY_PATHS) {
    assert.equal(yaml.includes(pattern), true, pattern);
  }
});

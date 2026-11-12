#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { MIN_TOKEN_LENGTH } from "grokcode-shared";

import { assertModelId, mergeAgentEnv, parseEnvFile } from "./envfile.js";

const MANAGED = [
  "GROKCODE_MACHINE_NAME",
  "GROKCODE_RELAY_URL",
  "GROKCODE_MACHINE_TOKEN",
  "GROKCODE_LISTEN",
  "GROKCODE_MCP_TOKEN",
  "OPENCODE_PASSWORD",
  "GROKCODE_DEFAULT_MODEL",
  "GROKCODE_OPENCODE_MODE",
  "GROKCODE_OPENCODE_ON_FOREIGN",
  "GROKCODE_OPENCODE_BIN",
  "GROKCODE_OPENCODE_URL",
  "GROKCODE_ALLOW_DIRS",
] as const;

export interface WriteConfigResult {
  file: string;
  password: "generated" | "kept" | "set";
}

export function updatesFromEnv(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const updates: Record<string, string | undefined> = {};
  for (const key of MANAGED) {
    const value = env[key];
    if (value == null) continue;
    const trimmed = value.trim();
    if (trimmed === "") continue;
    updates[key] = trimmed;
  }
  return updates;
}

export function writeAgentEnvFile(file: string, updates: Record<string, string | undefined>): WriteConfigResult {
  const token = updates.GROKCODE_MACHINE_TOKEN;
  if (token != null && token.length < MIN_TOKEN_LENGTH) {
    throw new Error(`Machine token must be at least ${MIN_TOKEN_LENGTH} characters.`);
  }
  const mcp = updates.GROKCODE_MCP_TOKEN;
  if (mcp != null && mcp.length < MIN_TOKEN_LENGTH) {
    throw new Error(`MCP token must be at least ${MIN_TOKEN_LENGTH} characters.`);
  }
  if (updates.GROKCODE_DEFAULT_MODEL) assertModelId(updates.GROKCODE_DEFAULT_MODEL, "GROKCODE_DEFAULT_MODEL");
  const mode = updates.GROKCODE_OPENCODE_MODE;
  if (mode && mode !== "auto" && mode !== "attach" && mode !== "spawn") {
    throw new Error("GROKCODE_OPENCODE_MODE must be auto, attach, or spawn.");
  }

  const existingText = existsSync(file) ? readFileSync(file, "utf8") : "";
  const existing = parseEnvFile(existingText);
  const next = { ...updates };
  let password: WriteConfigResult["password"];
  if (next.OPENCODE_PASSWORD) password = "set";
  else if (existing.OPENCODE_PASSWORD) password = "kept";
  else {
    next.OPENCODE_PASSWORD = randomBytes(32).toString("hex");
    password = "generated";
  }
  const body = mergeAgentEnv(existingText, next);
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* Windows permissions are applied by the installer. */
  }
  const tmp = path.join(dir, `.agent.env.${process.pid}.tmp`);
  writeFileSync(tmp, body, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* ignore */
  }
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    /* ignore */
  }
  return { file, password };
}

function takeFlag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value.`);
  return value;
}

const invokedDirectly = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

if (invokedDirectly) {
  try {
    const out = takeFlag(process.argv.slice(2), "--out");
    if (!out) throw new Error("Pass --out <path>.");
    const result = writeAgentEnvFile(out, updatesFromEnv(process.env));
    const passwordLine =
      result.password === "generated"
        ? "OpenCode password: generated and stored in the config file."
        : result.password === "kept"
          ? "OpenCode password: kept the existing value."
          : "OpenCode password: stored the provided value.";
    process.stdout.write(`Wrote ${result.file}\n${passwordLine}\n`);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

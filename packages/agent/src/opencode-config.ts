#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { assertModelId } from "./envfile.js";

export const OPENCODE_SCHEMA = "https://opencode.ai/config.json";

/**
 * OpenCode v2 reads `opencode.json` or `opencode.jsonc` from `~/.config/opencode/`
 * (on Windows, `%USERPROFILE%\.config\opencode\`). `model` is `provider/model`.
 * Prefer an existing file so comments in JSONC are preserved. Create JSON when neither exists.
 */
export function resolveOpenCodeConfigPath(home: string, exists: (file: string) => boolean = existsSync): { file: string; exists: boolean } {
  const dir = path.join(home, ".config", "opencode");
  const json = path.join(dir, "opencode.json");
  const jsonc = path.join(dir, "opencode.jsonc");
  if (exists(json)) return { file: json, exists: true };
  if (exists(jsonc)) return { file: jsonc, exists: true };
  return { file: json, exists: false };
}

export function upsertOpenCodeModel(source: string, model: string): string {
  assertModelId(model, "OpenCode model");
  if (source.trim() === "") {
    return `${JSON.stringify({ $schema: OPENCODE_SCHEMA, model }, null, 2)}\n`;
  }
  try {
    const parsed = JSON.parse(source) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("OpenCode config must be a JSON object.");
    }
    (parsed as Record<string, unknown>).model = model;
    return `${JSON.stringify(parsed, null, 2)}\n`;
  } catch (err) {
    if (err instanceof SyntaxError) return upsertJsoncModel(source, model);
    throw err;
  }
}

export function writeOpenCodeDefaultModel(home: string, model: string): string {
  const target = resolveOpenCodeConfigPath(home);
  const current = target.exists ? readFileSync(target.file, "utf8") : "";
  const next = upsertOpenCodeModel(current, model);
  mkdirSync(path.dirname(target.file), { recursive: true });
  writeFileSync(target.file, next, "utf8");
  return target.file;
}

function upsertJsoncModel(text: string, model: string): string {
  const literal = JSON.stringify(model);
  let i = skipWsAndComments(text, 0);
  if (text[i] !== "{") throw new Error("OpenCode config must be a JSON object.");
  const brace = i;
  i++;
  while (i < text.length) {
    i = skipWsAndComments(text, i);
    if (i >= text.length || text[i] === "}") break;
    if (text[i] === ",") {
      i++;
      continue;
    }
    if (text[i] !== '"') {
      throw new Error("Could not update the OpenCode config. Expected a quoted key near the top of the file.");
    }
    const key = readJsonString(text, i);
    i = skipWsAndComments(text, key.end);
    if (text[i] !== ":") throw new Error("Could not update the OpenCode config. Expected ':' after a key.");
    i = skipWsAndComments(text, i + 1);
    const value = readJsonValue(text, i);
    if (key.value === "model") return text.slice(0, value.start) + literal + text.slice(value.end);
    i = value.end;
  }
  return `${text.slice(0, brace + 1)}\n  "model": ${literal},${text.slice(brace + 1)}`;
}

function skipWsAndComments(text: string, i: number): number {
  while (i < text.length) {
    const ch = text[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
      continue;
    }
    if (text.startsWith("//", i)) {
      i += 2;
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    break;
  }
  return i;
}

function readJsonString(text: string, i: number): { value: string; end: number } {
  if (text[i] !== '"') throw new Error("Expected a string in the OpenCode config.");
  let value = "";
  for (let j = i + 1; j < text.length; j++) {
    const ch = text[j]!;
    if (ch === "\\") {
      const next = text[j + 1];
      if (next == null) break;
      value += next === "n" ? "\n" : next === "t" ? "\t" : next;
      j++;
      continue;
    }
    if (ch === '"') return { value, end: j + 1 };
    value += ch;
  }
  throw new Error("Unterminated string in the OpenCode config.");
}

function readJsonValue(text: string, i: number): { start: number; end: number } {
  const start = skipWsAndComments(text, i);
  const ch = text[start];
  if (ch === '"') return { start, end: readJsonString(text, start).end };
  if (ch === "{" || ch === "[") return { start, end: skipBalanced(text, start) };
  let end = start;
  while (end < text.length && !/[\s,}\]]/.test(text[end]!)) end++;
  if (end === start) throw new Error("Expected a value in the OpenCode config.");
  return { start, end };
}

function skipBalanced(text: string, i: number): number {
  const open = text[i];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let j = i; j < text.length; j++) {
    const ch = text[j]!;
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "/" && text[j + 1] === "/") {
      while (j < text.length && text[j] !== "\n") j++;
      continue;
    }
    if (ch === "/" && text[j + 1] === "*") {
      const end = text.indexOf("*/", j + 2);
      if (end < 0) throw new Error("Unterminated comment in the OpenCode config.");
      j = end + 1;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return j + 1;
    }
  }
  throw new Error("Unterminated value in the OpenCode config.");
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
    const model = takeFlag(process.argv.slice(2), "--model");
    if (!model) throw new Error("Pass --model provider/model.");
    const home = takeFlag(process.argv.slice(2), "--home") || process.env.USERPROFILE || process.env.HOME;
    if (!home) throw new Error("Could not resolve the home directory. Pass --home.");
    const file = writeOpenCodeDefaultModel(home, model);
    process.stdout.write(`Updated OpenCode default model in ${file}\n`);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

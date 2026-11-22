#!/usr/bin/env node
// Fail when a Wrangler config declares a worker secret as a plain var.
// `wrangler deploy` keeps secrets set with `wrangler secret put`, except when
// the same name is a [vars] entry: that plaintext value replaces the secret.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const WORKER_SECRET_NAMES = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "MACHINE_TOKENS",
  "MCP_TOKEN",
  "OAUTH_CLIENTS",
  "OAUTH_PINNED_REDIRECTS",
  "OWNER_APPROVAL_SECRET",
  "OWNER_EMAILS",
  "PUBLIC_ORIGIN",
];

const SECRET_NAMES = new Set(WORKER_SECRET_NAMES);
const CONFIG_FILES = ["wrangler.json", "wrangler.jsonc", "wrangler.toml"];

/**
 * @param {string} section
 */
export function isVarsSection(section) {
  return section === "vars" || section.endsWith(".vars");
}

/**
 * @param {string} file
 * @param {string} text
 * @returns {{ file: string, section: string, name: string }[]}
 */
export function findSecretVars(file, text) {
  if (file.endsWith(".toml")) return findTomlSecretVars(file, text);
  return findJsonSecretVars(file, text);
}

/**
 * @param {string} directory
 */
export async function secretVarCollisions(directory) {
  /** @type {{ name: string, text: string }[]} */
  const present = [];
  for (const name of CONFIG_FILES) {
    try {
      const text = await readFile(path.join(directory, name), "utf8");
      present.push({ name, text });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
  }
  if (present.length === 0) {
    throw new Error(`No wrangler.toml, wrangler.json, or wrangler.jsonc in ${directory}.`);
  }
  if (present.length > 1) {
    throw new Error(
      `Found ${present.map((file) => file.name).join(" and ")} in ${directory}. Keep a single Wrangler config so deploy cannot read a second file.`,
    );
  }
  const hits = present.flatMap((file) => findSecretVars(file.name, file.text));
  return { files: present.map((file) => file.name), hits };
}

/**
 * @param {string} line
 */
function stripTomlComment(line) {
  let quote = "";
  let out = "";
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quote) {
      out += char;
      if (char === "\\" && quote === '"') {
        out += line[i + 1] ?? "";
        i += 1;
        continue;
      }
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      out += char;
      continue;
    }
    if (char === "#") return out;
    out += char;
  }
  return out;
}

/**
 * @param {string} fragment
 */
function tomlKey(fragment) {
  const match = fragment.trim().match(/^(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*=/);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

/**
 * @param {string} body
 */
function splitTopLevelCommas(body) {
  /** @type {string[]} */
  const parts = [];
  let quote = "";
  let depth = 0;
  let current = "";
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (quote) {
      current += char;
      if (char === "\\" && quote === '"') {
        current += body[i + 1] ?? "";
        i += 1;
        continue;
      }
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "{" || char === "[") {
      depth += 1;
      current += char;
      continue;
    }
    if (char === "}" || char === "]") {
      depth = Math.max(0, depth - 1);
      current += char;
      continue;
    }
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

/**
 * @param {string} file
 * @param {string} text
 */
function findTomlSecretVars(file, text) {
  /** @type {{ file: string, section: string, name: string }[]} */
  const hits = [];
  let section = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = stripTomlComment(raw).trim();
    if (!line) continue;
    const header = line.match(/^\[\[?([^\]]+)\]\]?$/);
    if (header) {
      section = header[1].trim();
      continue;
    }
    if (isVarsSection(section)) {
      const name = tomlKey(line);
      if (name && SECRET_NAMES.has(name)) hits.push({ file, section, name });
      continue;
    }
    const inline = line.match(/^vars\s*=\s*\{(.*)\}\s*$/);
    if (!inline) continue;
    for (const part of splitTopLevelCommas(inline[1])) {
      const name = tomlKey(part);
      if (name && SECRET_NAMES.has(name)) hits.push({ file, section: "vars", name });
    }
  }
  return hits;
}

/**
 * @param {string} text
 */
function stripJsonComments(text) {
  let out = "";
  let quote = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];
    if (quote) {
      out += char;
      if (char === "\\") {
        out += next ?? "";
        i += 1;
        continue;
      }
      if (char === '"') quote = false;
      continue;
    }
    if (char === '"') {
      quote = true;
      out += char;
      continue;
    }
    if (char === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 1;
      continue;
    }
    out += char;
  }
  return out;
}

/**
 * @param {string} text
 */
function stripTrailingCommas(text) {
  let out = "";
  let quote = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      out += char;
      if (char === "\\") {
        out += text[i + 1] ?? "";
        i += 1;
        continue;
      }
      if (char === '"') quote = false;
      continue;
    }
    if (char === '"') {
      quote = true;
      out += char;
      continue;
    }
    if (char === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j += 1;
      if (text[j] === "}" || text[j] === "]") continue;
    }
    out += char;
  }
  return out;
}

/**
 * @param {unknown} value
 * @param {string} section
 * @param {{ file: string, section: string, name: string }[]} hits
 * @param {string} file
 */
function walkJson(value, section, hits, file) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  if (isVarsSection(section)) {
    for (const name of Object.keys(value)) {
      if (SECRET_NAMES.has(name)) hits.push({ file, section, name });
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    walkJson(child, section ? `${section}.${key}` : key, hits, file);
  }
}

/**
 * @param {string} file
 * @param {string} text
 */
function findJsonSecretVars(file, text) {
  let parsed;
  try {
    parsed = JSON.parse(stripTrailingCommas(stripJsonComments(text)));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${file} could not be parsed, so the secret-var check cannot clear it: ${message}`);
  }
  /** @type {{ file: string, section: string, name: string }[]} */
  const hits = [];
  walkJson(parsed, "", hits, file);
  return hits;
}

async function main() {
  const directory = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
  try {
    const { hits } = await secretVarCollisions(directory);
    if (hits.length === 0) return;
    for (const hit of hits) {
      console.error(
        `::error::${hit.file} [${hit.section}] declares ${hit.name}. That plain var would replace the worker secret on deploy. Remove it from the Wrangler config and set it with \`wrangler secret put ${hit.name}\`.`,
      );
    }
    process.exitCode = 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`::error::${message}`);
    process.exitCode = 1;
  }
}

const entry = process.argv[1];
if (entry && path.resolve(entry) === fileURLToPath(import.meta.url)) {
  await main();
}

import fs from "node:fs/promises";

import { ToolError } from "grokcode-shared";

import { expandLexical, isSensitivePath, pathApi } from "./confine.js";
import { confineCwd, confineFile, type FileContext } from "./files.js";
import { redact } from "./redact.js";
import { evaluateCommand } from "./policy.js";
import { SEARCH_IGNORED_DIRECTORIES } from "./tools.js";

const MAX_ENTRIES = 5_000;
const MAX_MATCHES = 100;
const MAX_BYTES = 8_000_000;
const SKIP_DIRS = new Set<string>(SEARCH_IGNORED_DIRECTORIES);
const SOURCE_MAP = /\.map$/i;

function matchesGlob(name: string, glob: string): boolean {
  let pos = 0;
  let pattern = 0;
  let star = -1;
  let retry = 0;
  while (pos < name.length) {
    if (glob[pattern] === "*") {
      star = pattern++;
      retry = pos;
    } else if (glob[pattern] === "?" || glob[pattern] === name[pos]) {
      pos++;
      pattern++;
    } else if (star !== -1) {
      pattern = star + 1;
      pos = ++retry;
    } else {
      return false;
    }
  }
  return /^\**$/.test(glob.slice(pattern));
}

export async function searchFiles(input: string, query: string, options: { glob?: string; includeIgnored: boolean }, ctx: FileContext) {
  const cwd = expandLexical(input, ctx.platform, ctx.home);
  const root = confineCwd(cwd, ctx);
  const decision = evaluateCommand(ctx.policy, ["rg"], { platform: ctx.platform, cwd: root, home: ctx.home });
  if (!decision.allow) throw new ToolError(decision.reason, "policy_denied");
  const path = pathApi(ctx.platform);
  const scope = { ...ctx, policy: { ...ctx.policy, roots: [root] } };
  const { glob, includeIgnored } = options;
  const skipMaps = !glob || !SOURCE_MAP.test(glob);
  const skipped = {
    directories: includeIgnored ? [] : SEARCH_IGNORED_DIRECTORIES,
    hiddenPaths: true,
    sensitivePaths: true,
    symlinks: true,
    binaryFiles: true,
    filePatterns: skipMaps ? ["*.map"] : [],
  };
  const matches: Array<{ path: string; line: number; text: string }> = [];
  let entries = 0;
  let bytes = 0;
  let outputBytes = 0;
  let filesPartiallyScanned = false;
  const outputCap = Math.min(32_768, ctx.policy.limits.maxOutputBytes);
  const result = (resultsCapped = false, scanLimit: "entries" | "bytes" | null = null) => ({
    cwd, glob: glob ?? null, skipped, resultsCapped, filesPartiallyScanned, scanLimit,
    truncated: resultsCapped || filesPartiallyScanned || scanLimit !== null,
    matches,
  });
  const dirs = [root];
  while (dirs.length) {
    const dir = confineFile(dirs.pop()!, scope, undefined, false, false);
    const handle = await fs.opendir(dir);
    for await (const entry of handle) {
      if (++entries > MAX_ENTRIES) return result(false, "entries");
      const target = path.join(dir, entry.name);
      if (entry.name.startsWith(".") || entry.isSymbolicLink() || isSensitivePath(target, ctx.platform)) continue;
      if (entry.isDirectory()) {
        if (includeIgnored || !SKIP_DIRS.has(entry.name.toLowerCase())) dirs.push(target);
        continue;
      }
      if (!entry.isFile() || (skipMaps && SOURCE_MAP.test(entry.name)) || (glob && !matchesGlob(entry.name, glob))) continue;
      if (bytes >= MAX_BYTES) return result(false, "bytes");
      const file = confineFile(target, scope, undefined, false, false);
      const cap = Math.min(MAX_BYTES - bytes, ctx.policy.limits.maxReadBytes);
      const fd = await fs.open(file, "r");
      let content: string;
      try {
        const stat = await fd.stat();
        if (!stat.isFile()) continue;
        const buffer = Buffer.alloc(Math.min(cap, stat.size));
        const { bytesRead } = await fd.read(buffer, 0, buffer.length, 0);
        bytes += bytesRead;
        filesPartiallyScanned ||= bytesRead < stat.size;
        content = buffer.subarray(0, bytesRead).toString("utf8");
      } finally {
        await fd.close();
      }
      if (content.includes("\0")) continue;
      const displayPath = path.join(cwd, path.relative(root, target));
      const lines = redact(content).split(/\r?\n/);
      for (const [index, line] of lines.entries()) {
        if (!line.includes(query)) continue;
        const match = { path: displayPath, line: index + 1, text: line.slice(0, 1_000) };
        outputBytes += Buffer.byteLength(JSON.stringify(match));
        if (matches.length >= MAX_MATCHES || outputBytes > outputCap) return result(true);
        matches.push(match);
      }
    }
  }
  return result();
}

import fs from "node:fs/promises";

import { ToolError } from "grokcode-shared";

import { compareKey, expandLexical, isSensitivePath, pathApi } from "./confine.js";
import { confineCwd, confineFile, type FileContext } from "./files.js";
import { redact } from "./redact.js";
import { evaluateCommand } from "./policy.js";
import { SEARCH_IGNORED_DIRECTORIES } from "./tools.js";

const MAX_ENTRIES = 5_000;
const MAX_MATCHES = 100;
const MAX_BYTES = 8_000_000;
const MAX_BYTES_WITH_IGNORED = 32_000_000;
const SOURCE_MAP = /\.map$/i;

interface SearchDirectory {
  target: string;
  display: string;
  packageLink?: boolean;
}

/** Only installed package aliases may lead into the virtual store. */
async function resolvePnpmPackage(input: string, ctx: FileContext): Promise<string | undefined> {
  const path = pathApi(ctx.platform);
  const parent = path.dirname(input);
  const modules = path.basename(parent).startsWith("@") ? path.dirname(parent) : parent;
  if (compareKey(path.basename(modules), ctx.platform) !== "node_modules") return;
  const alias = path.relative(modules, input);
  try {
    const target = confineFile(input, ctx, undefined, false, true);
    const parts = path.relative(path.join(modules, ".pnpm"), target).split(path.sep);
    if (!parts[0] || parts[0].startsWith(".") || parts[1] !== "node_modules") return;
    if (compareKey(parts.slice(2).join(path.sep), ctx.platform) !== compareKey(alias, ctx.platform)) return;
    if ((await fs.lstat(target)).isDirectory()) return target;
  } catch {
    // Broken, sensitive, and out-of-scope links do not participate in the search.
  }
}

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

export async function searchFiles(input: string, query: string, options: { glob?: string; includeIgnored: boolean }, ctx: FileContext, signal?: AbortSignal) {
  const cwd = expandLexical(input, ctx.platform, ctx.home);
  const root = confineCwd(cwd, ctx);
  const decision = evaluateCommand(ctx.policy, ["rg"], { platform: ctx.platform, cwd: root, home: ctx.home });
  if (!decision.allow) throw new ToolError(decision.reason, "policy_denied");
  const path = pathApi(ctx.platform);
  const scope = { ...ctx, policy: { ...ctx.policy, roots: [root] } };
  const { glob, includeIgnored } = options;
  const byteLimit = includeIgnored ? MAX_BYTES_WITH_IGNORED : MAX_BYTES;
  const skipMaps = !glob || !SOURCE_MAP.test(glob);
  const inDependency = path.dirname(root).split(path.sep).some((part) => compareKey(part, ctx.platform) === "node_modules");
  const skippedDirectories = includeIgnored ? [] : inDependency ? ["node_modules"] : SEARCH_IGNORED_DIRECTORIES;
  const skipDirs = new Set<string>(skippedDirectories);
  const skipped = {
    directories: skippedDirectories,
    hiddenPaths: true,
    sensitivePaths: true,
    symlinks: true,
    symlinkExceptions: includeIgnored ? ["in-scope pnpm package aliases"] : [],
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
  const initial = { target: root, display: cwd };
  const dependencySearch = includeIgnored && (inDependency || compareKey(path.basename(root), ctx.platform) === "node_modules");
  const dirs: SearchDirectory[] = dependencySearch ? [] : [initial];
  // Share the traversal budget between sibling dependency trees.
  const dependencies: SearchDirectory[] = dependencySearch ? [initial] : [];
  const visited = new Set<string>();
  while (dirs.length || dependencies.length) {
    signal?.throwIfAborted();
    const dependency = dependencies.shift();
    const current = dependency ?? dirs.pop()!;
    const resolved = current.packageLink ? await resolvePnpmPackage(current.target, scope) : current.target;
    if (!resolved) continue;
    const dir = confineFile(resolved, scope, undefined, false, false);
    const key = compareKey(dir, ctx.platform);
    if (visited.has(key)) continue;
    visited.add(key);
    const handle = await fs.opendir(dir);
    for await (const entry of handle) {
      signal?.throwIfAborted();
      if (++entries > MAX_ENTRIES) return result(false, "entries");
      const target = path.join(dir, entry.name);
      if (entry.name.startsWith(".") || isSensitivePath(target, ctx.platform)) continue;
      const display = path.join(current.display, entry.name);
      if (entry.isSymbolicLink()) {
        if (dependency) dependencies.push({ target, display, packageLink: true });
        continue;
      }
      if (entry.isDirectory()) {
        const name = entry.name.toLowerCase();
        if (skipDirs.has(name)) continue;
        const pending = dependency || (includeIgnored && name === "node_modules") ? dependencies : dirs;
        pending.push({ target, display });
        continue;
      }
      if (!entry.isFile() || (skipMaps && SOURCE_MAP.test(entry.name)) || (glob && !matchesGlob(entry.name, glob))) continue;
      if (bytes >= byteLimit) return result(false, "bytes");
      const file = confineFile(target, scope, undefined, false, false);
      const cap = Math.min(byteLimit - bytes, ctx.policy.limits.maxReadBytes);
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
      if (content.includes("\0") || !content.includes(query)) continue;
      const lines = redact(content).split(/\r?\n/);
      for (const [index, line] of lines.entries()) {
        if (!line.includes(query)) continue;
        const match = { path: display, line: index + 1, text: line.slice(0, 1_000) };
        outputBytes += Buffer.byteLength(JSON.stringify(match));
        if (matches.length >= MAX_MATCHES || outputBytes > outputCap) return result(true);
        matches.push(match);
      }
    }
  }
  return result();
}

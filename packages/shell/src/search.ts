import fs from "node:fs/promises";

import { ToolError } from "grokcode-shared";

import { isSensitivePath, pathApi } from "./confine.js";
import { confineFile, type FileContext } from "./files.js";
import { redact } from "./redact.js";
import { evaluateCommand } from "./policy.js";

const MAX_ENTRIES = 5_000;
const MAX_MATCHES = 100;
const MAX_BYTES = 8_000_000;
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "target", "__pycache__"]);

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

export async function searchFiles(cwd: string, query: string, glob: string | undefined, ctx: FileContext) {
  const decision = evaluateCommand(ctx.policy, ["rg"], { platform: ctx.platform, cwd, home: ctx.home });
  if (!decision.allow) throw new ToolError(decision.reason, "policy_denied");
  const path = pathApi(ctx.platform);
  const matches: Array<{ path: string; line: number; text: string }> = [];
  let entries = 0;
  let bytes = 0;
  let outputBytes = 0;
  let truncated = false;
  const outputCap = Math.min(32_768, ctx.policy.limits.maxOutputBytes);
  const dirs = [cwd];
  while (dirs.length) {
    const dir = confineFile(dirs.pop()!, ctx, cwd, false, true);
    const handle = await fs.opendir(dir);
    for await (const entry of handle) {
      if (++entries > MAX_ENTRIES || bytes >= MAX_BYTES) return { cwd, matches, truncated: true };
      const target = path.join(dir, entry.name);
      if (entry.name.startsWith(".") || entry.isSymbolicLink() || isSensitivePath(target, ctx.platform)) continue;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name.toLowerCase())) dirs.push(target);
        continue;
      }
      if (!entry.isFile() || (glob && !matchesGlob(entry.name, glob))) continue;
      const file = confineFile(target, ctx, cwd, false, true);
      const cap = Math.min(MAX_BYTES - bytes, ctx.policy.limits.maxReadBytes);
      const fd = await fs.open(file, "r");
      let content: string;
      try {
        const stat = await fd.stat();
        if (!stat.isFile()) continue;
        const buffer = Buffer.alloc(Math.min(cap, stat.size));
        const { bytesRead } = await fd.read(buffer, 0, buffer.length, 0);
        bytes += bytesRead;
        truncated ||= bytesRead < stat.size;
        content = buffer.subarray(0, bytesRead).toString("utf8");
      } finally {
        await fd.close();
      }
      if (content.includes("\0")) continue;
      const lines = redact(content).split(/\r?\n/);
      for (const [index, line] of lines.entries()) {
        if (!line.includes(query)) continue;
        const match = { path: target, line: index + 1, text: line.slice(0, 1_000) };
        outputBytes += Buffer.byteLength(JSON.stringify(match));
        if (matches.length >= MAX_MATCHES || outputBytes > outputCap) return { cwd, matches, truncated: true };
        matches.push(match);
      }
    }
  }
  return { cwd, matches, truncated };
}

import fs from "node:fs";

import { ToolError } from "grokcode-shared";

import { isSensitivePath, pathApi } from "./confine.js";
import { confineFile, readFile, type FileContext } from "./files.js";
import { evaluateCommand } from "./policy.js";

const MAX_ENTRIES = 5_000;
const MAX_MATCHES = 100;

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

export function searchFiles(cwd: string, query: string, glob: string | undefined, ctx: FileContext) {
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
    const handle = fs.opendirSync(dir);
    try {
      for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
        if (++entries > MAX_ENTRIES || bytes >= 8_000_000) return { cwd, matches, truncated: true };
        const target = path.join(dir, entry.name);
        if (entry.name.startsWith(".") || entry.isSymbolicLink() || isSensitivePath(target, ctx.platform)) continue;
        if (entry.isDirectory()) {
          dirs.push(target);
          continue;
        }
        if (!entry.isFile() || (glob && !matchesGlob(entry.name, glob))) continue;
        const result = readFile(target, ctx);
        bytes += result.bytes;
        truncated ||= result.truncated;
        if (result.content.includes("\0")) continue;
        const lines = result.content.split(/\r?\n/);
        for (const [index, line] of lines.entries()) {
          if (!line.includes(query)) continue;
          const match = { path: target, line: index + 1, text: line.slice(0, 1_000) };
          outputBytes += Buffer.byteLength(JSON.stringify(match));
          if (matches.length >= MAX_MATCHES || outputBytes > outputCap) return { cwd, matches, truncated: true };
          matches.push(match);
        }
      }
    } finally {
      handle.closeSync();
    }
  }
  return { cwd, matches, truncated };
}

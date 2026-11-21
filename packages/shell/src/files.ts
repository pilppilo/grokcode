import fs from "node:fs";
import { randomBytes } from "node:crypto";

import { ToolError, type PathPlatform } from "grokcode-shared";

import { confine, pathApi } from "./confine.js";
import type { Policy } from "./policy.js";
import { redact } from "./redact.js";

export interface FileContext {
  policy: Policy;
  platform: PathPlatform;
  home: string;
}

export function confineCwd(cwd: string, ctx: FileContext): string {
  return confine(cwd, {
    roots: ctx.policy.roots,
    platform: ctx.platform,
    home: ctx.home,
    allowMissing: false,
    followFinal: true,
  });
}

export function confineFile(input: string, ctx: FileContext, cwd: string | undefined, allowMissing: boolean, followFinal: boolean): string {
  return confine(input, {
    roots: ctx.policy.roots,
    platform: ctx.platform,
    home: ctx.home,
    ...(cwd ? { cwd } : {}),
    allowMissing,
    followFinal,
  });
}

export function readFile(input: string, ctx: FileContext, offset = 0, maxBytes?: number, lines?: { start: number; end?: number }): { path: string; content: string; bytes: number; nextOffset: number; truncated: boolean } {
  const file = confineFile(input, ctx, undefined, false, true);
  const st = fs.lstatSync(file);
  if (st.isSymbolicLink() || !st.isFile()) throw new ToolError("path is not a regular file.", "invalid_path");
  const cap = Math.min(maxBytes ?? 32_768, ctx.policy.limits.maxReadBytes);
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const start = lines ? lineOffset(fd, size, lines.start) : Math.min(size, Math.max(0, offset));
    const length = Math.min(cap, Math.max(0, size - start));
    const buffer = Buffer.alloc(length);
    let read = length === 0 ? 0 : fs.readSync(fd, buffer, 0, length, start);
    let end = size;
    if (lines?.end !== undefined) {
      let remaining = lines.end - lines.start + 1;
      for (let i = 0; i < read; i++) {
        if (buffer[i] === 10 && --remaining === 0) {
          read = i + 1;
          end = start + read;
          break;
        }
      }
    }
    // Leave an incomplete UTF-8 character for the next page when it fits the window.
    if (read > 0 && start + read < end) {
      let lead = read - 1;
      while (lead > 0 && (buffer[lead]! & 0xc0) === 0x80) lead--;
      const byte = buffer[lead]!;
      const width = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
      if (lead > 0 && read - lead < width) read = lead;
    }
    const sourceCode = /\.(?:[cm]?[jt]sx?|py|go|rs|sh|bash|zsh|fish|ps1|rb|php|java|kt|swift|c|h|cpp|cs|lua)$/i.test(file);
    const content = redact(buffer.subarray(0, read).toString("utf8"), sourceCode);
    return { path: file, content, bytes: read, nextOffset: start + read, truncated: start + read < end };
  } finally {
    fs.closeSync(fd);
  }
}

function lineOffset(fd: number, size: number, line: number): number {
  const chunk = Buffer.alloc(32_768);
  let offset = 0;
  while (line > 1 && offset < size) {
    if (offset >= 50_000_000) throw new ToolError("line starts beyond the scan limit.", "too_large");
    const length = fs.readSync(fd, chunk, 0, Math.min(chunk.length, size - offset), offset);
    if (length === 0) break;
    for (let i = 0; i < length; i++) {
      if (chunk[i] === 10 && --line === 1) return offset + i + 1;
    }
    offset += length;
  }
  return offset;
}

export function listDir(input: string, ctx: FileContext): { path: string; entries: Array<{ name: string; type: "file" | "dir" | "symlink" | "other" }>; truncated: boolean } {
  const dir = confineFile(input, ctx, undefined, false, true);
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new ToolError("path is not a directory.", "invalid_path");
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .map((entry) => ({
      name: entry.name,
      type: entry.isSymbolicLink() ? ("symlink" as const) : entry.isDirectory() ? ("dir" as const) : entry.isFile() ? ("file" as const) : ("other" as const),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { path: dir, entries: entries.slice(0, 500), truncated: entries.length > 500 };
}

export function writeFile(input: string, contents: string, ctx: FileContext): { path: string; bytes: number } {
  if (typeof contents !== "string") throw new ToolError("contents must be a string.", "invalid_argument");
  const bytes = Buffer.byteLength(contents);
  if (bytes > ctx.policy.limits.maxWriteBytes) {
    throw new ToolError(`contents exceed the write cap of ${ctx.policy.limits.maxWriteBytes} bytes.`, "too_large");
  }
  const file = confineFile(input, ctx, undefined, true, false);
  const path = pathApi(ctx.platform);
  const parent = path.dirname(file);
  confineFile(parent, ctx, undefined, true, true);
  fs.mkdirSync(parent, { recursive: true });
  const tmp = path.join(parent, `.grokcode-${randomBytes(8).toString("hex")}.tmp`);
  fs.writeFileSync(tmp, Buffer.from(contents, "utf8"));
  fs.renameSync(tmp, file);
  return { path: file, bytes };
}

export function removeFile(input: string, ctx: FileContext): void {
  const file = confineFile(input, ctx, undefined, false, false);
  fs.unlinkSync(file);
}

export function validatePatchFile(abs: string, allowMissing: boolean): void {
  const stat = fs.lstatSync(abs, { throwIfNoEntry: false });
  if ((!stat && !allowMissing) || (stat && !stat.isFile())) {
    throw new ToolError("patch path is not a regular file.", "invalid_path");
  }
}

export function readTextIfExists(abs: string, maxBytes: number): string {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(abs);
  } catch {
    return "";
  }
  if (st.isSymbolicLink() || !st.isFile()) return "";
  if (st.size > maxBytes) throw new ToolError("file is too large to patch.", "too_large");
  return fs.readFileSync(abs, "utf8");
}

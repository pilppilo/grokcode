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

export function readFile(input: string, ctx: FileContext, offset = 0, maxBytes?: number): { path: string; content: string; bytes: number; truncated: boolean } {
  const file = confineFile(input, ctx, undefined, false, true);
  const st = fs.lstatSync(file);
  if (st.isSymbolicLink() || !st.isFile()) throw new ToolError("path is not a regular file.", "invalid_path");
  const cap = Math.min(maxBytes ?? ctx.policy.limits.maxReadBytes, ctx.policy.limits.maxReadBytes);
  const start = Math.max(0, offset);
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const length = Math.min(cap, Math.max(0, size - start));
    const buffer = Buffer.alloc(length);
    const read = length === 0 ? 0 : fs.readSync(fd, buffer, 0, length, start);
    const sourceCode = /\.[cm]?[jt]sx?$/i.test(file);
    const content = redact(buffer.subarray(0, read).toString("utf8"), sourceCode);
    return { path: file, content, bytes: read, truncated: start + read < size };
  } finally {
    fs.closeSync(fd);
  }
}

export function listDir(input: string, ctx: FileContext): { path: string; entries: Array<{ name: string; type: "file" | "dir" | "symlink" | "other" }> } {
  const dir = confineFile(input, ctx, undefined, false, true);
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new ToolError("path is not a directory.", "invalid_path");
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .slice(0, 500)
    .map((entry) => ({
      name: entry.name,
      type: entry.isSymbolicLink() ? ("symlink" as const) : entry.isDirectory() ? ("dir" as const) : entry.isFile() ? ("file" as const) : ("other" as const),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { path: dir, entries };
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

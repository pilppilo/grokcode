import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

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

export const READ_PAGE_BYTES = 38_000;
const READ_PAGE_LINES = 800;

export interface ReadPageOptions {
  offset?: number | undefined;
  maxBytes?: number | undefined;
  startLine?: number | undefined;
  endLine?: number | undefined;
}

export function readFilePage(input: string, ctx: FileContext, options: ReadPageOptions, signal?: AbortSignal) {
  const file = regularFile(input, ctx);
  return readPage(file, ctx.policy.limits.maxReadBytes, options, false, signal);
}

/** The caller authorizes the generated path. Do not pass a client-supplied path here. */
export async function readPage(file: string, maxReadBytes: number, options: ReadPageOptions, alreadyRedacted = false, signal?: AbortSignal) {
  const expected = fs.lstatSync(file);
  if (!expected.isFile() || (alreadyRedacted && expected.nlink !== 1)) {
    throw new ToolError("path is not a regular file.", "invalid_path");
  }
  const fd = await fs.promises.open(file, "r");
  try {
    const stat = await fd.stat();
    if (!stat.isFile() || stat.ino !== expected.ino || stat.dev !== expected.dev) {
      throw new ToolError("path changed before the read.", "file_changed");
    }
    const totalBytes = stat.size;
    const requested = Math.min(options.offset ?? 0, totalBytes);
    const first = options.startLine ?? 1;
    let rangeStart = first === 1 ? 0 : totalBytes;
    let rangeEnd = totalBytes;
    let offsetLine = 1;
    let offsetAtLineStart = requested === 0;
    let breaks = 0;
    let lastByte: number | undefined;
    const chunk = Buffer.alloc(64 * 1024);
    for (let position = 0; position < totalBytes;) {
      signal?.throwIfAborted();
      const { bytesRead: count } = await fd.read(chunk, 0, Math.min(chunk.length, totalBytes - position), position);
      if (count === 0) throw new ToolError("The file changed during the read. Start again.", "file_changed");
      const data = chunk.subarray(0, count);
      lastByte = data[count - 1];
      for (let i = data.indexOf(10); i !== -1; i = data.indexOf(10, i + 1)) {
        const after = position + i + 1;
        breaks++;
        if (breaks + 1 === first) rangeStart = after;
        if (breaks === options.endLine) rangeEnd = after;
        if (after <= requested) offsetLine++;
        if (after === requested) offsetAtLineStart = true;
      }
      position += count;
    }
    const totalLines = breaks + (totalBytes > 0 && lastByte !== 10 ? 1 : 0);
    const start = options.offset === undefined ? rangeStart : requested;
    if (start < rangeStart || start > rangeEnd) {
      throw new ToolError("offset is outside the requested line range.", "invalid_argument");
    }
    const cap = Math.min(options.maxBytes ?? READ_PAGE_BYTES, READ_PAGE_BYTES, maxReadBytes);
    const available = Math.min(cap + 1, rangeEnd - start);
    const buffer = Buffer.alloc(available);
    let filled = 0;
    while (filled < available) {
      signal?.throwIfAborted();
      const { bytesRead: count } = await fd.read(buffer, filled, available - filled, start + filled);
      if (count === 0) throw new ToolError("The file changed during the read. Start again.", "file_changed");
      filled += count;
    }
    if (available > 0 && isUtf8Continuation(buffer[0]!)) {
      throw new ToolError("offset must be on a UTF-8 character boundary.", "invalid_argument");
    }
    let bytes = Math.min(cap, available);
    const startLine = bytes === 0 ? null : options.offset === undefined ? first : offsetLine;
    let pageBreaks = 0;
    for (let i = buffer.indexOf(10); i !== -1 && i < bytes; i = buffer.indexOf(10, i + 1)) {
      if (++pageBreaks === READ_PAGE_LINES) {
        bytes = i + 1;
        break;
      }
    }
    while (bytes > 0 && bytes < available && isUtf8Continuation(buffer[bytes]!)) bytes--;
    if (bytes === 0 && available > 0) {
      throw new ToolError("maxBytes is too small for the next UTF-8 character.", "invalid_argument");
    }
    const endLine = startLine === null ? null : startLine + pageBreaks - (buffer[bytes - 1] === 10 ? 1 : 0);
    const nextOffset = start + bytes;
    const hasMore = nextOffset < rangeEnd;
    const fileComplete = start === 0 && nextOffset === totalBytes;
    const current = await fd.stat();
    signal?.throwIfAborted();
    if (current.size !== totalBytes || current.mtimeMs !== stat.mtimeMs || current.ctimeMs !== stat.ctimeMs) {
      throw new ToolError("The file changed during the read. Start again.", "file_changed");
    }
    const content = buffer.subarray(0, bytes).toString("utf8");
    const startsMidLine = options.offset !== undefined && !offsetAtLineStart;
    const endsMidLine = nextOffset < totalBytes && buffer[bytes - 1] !== 10;
    const shownInFull = startLine === null || endLine === null ? 0
      : Math.max(0, endLine - startLine + 1 - Number(startsMidLine) - Number(endsMidLine));
    const missingLines = totalLines - shownInFull;
    const shown = startLine === null ? "No lines shown" : `Showing lines ${startLine}-${endLine}`;
    let coverage = `${shown} of ${totalLines}.`;
    if (fileComplete) {
      coverage += " This response covers the whole file.";
    } else {
      coverage += ` This response leaves ${missingLines} ${missingLines === 1 ? "line" : "lines"} unread or partially read.`;
      const restart = "startLine=1 (omit offset and endLine).";
      const continueByLine = endLine !== null && nextOffset < totalBytes;
      if (hasMore) {
        coverage += ` Continue with offset=${nextOffset}, keeping the same line range.`;
      } else if (continueByLine) {
        coverage += ` Continue with startLine=${endLine + 1} (omit offset and endLine).`;
      } else {
        coverage += ` Read from the beginning with ${restart}`;
      }
      if (start > 0 && (hasMore || continueByLine)) {
        coverage += ` For earlier content, use ${restart}`;
      }
    }
    return {
      path: file,
      coverage,
      content: alreadyRedacted ? content : redact(content, isSourceFile(file)),
      bytes,
      nextOffset,
      truncated: hasMore,
      hasMore,
      fileComplete,
      startLine,
      endLine,
      totalLines,
      totalBytes,
    };
  } finally {
    await fd.close();
  }
}

function isUtf8Continuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

function regularFile(input: string, ctx: FileContext): string {
  const file = confineFile(input, ctx, undefined, false, true);
  const st = fs.lstatSync(file);
  if (st.isSymbolicLink() || !st.isFile()) throw new ToolError("path is not a regular file.", "invalid_path");
  return file;
}

function isSourceFile(file: string): boolean {
  return /\.(?:[cm]?[jt]sx?|py|go|rs|sh|bash|zsh|fish|ps1|rb|php|java|kt|swift|c|h|cpp|cs|lua)$/i.test(file);
}

export function readGuidanceFile(input: string, ctx: FileContext, maxBytes: number): { content: string; truncated: boolean } {
  const file = regularFile(input, ctx);
  const cap = Math.min(maxBytes, ctx.policy.limits.maxReadBytes);
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const length = Math.min(cap, size);
    const buffer = Buffer.alloc(length);
    const read = length === 0 ? 0 : fs.readSync(fd, buffer, 0, length, 0);
    const truncated = read < size;
    const data = buffer.subarray(0, read);
    const text = truncated ? new StringDecoder("utf8").write(data) : data.toString("utf8");
    return { content: redact(text), truncated };
  } finally {
    fs.closeSync(fd);
  }
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

/** A `.git` gitfile (`gitdir: ...`) points Git at another directory and can run that directory's hooks. */
export function isGitdirPointer(contents: string): boolean {
  return /^\uFEFF?\s*gitdir\s*:/i.test(contents);
}

function isGitSegment(part: string, platform: PathPlatform): boolean {
  return platform === "win32" ? part.toLowerCase() === ".git" : part === ".git";
}

export function writeFile(input: string, contents: string, ctx: FileContext, expected?: fs.Stats): { path: string; bytes: number } {
  if (typeof contents !== "string") throw new ToolError("contents must be a string.", "invalid_argument");
  const segments = input.split(/[\\/]/).filter(Boolean);
  if (segments.some((part) => isGitSegment(part, ctx.platform)) || (isGitdirPointer(contents) && isGitSegment(segments.at(-1) ?? "", ctx.platform))) {
    throw new ToolError("gitdir files are denied.", "path_denied");
  }
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
  const fd = fs.openSync(tmp, "wx", expected ? expected.mode & 0o777 : 0o666);
  let renamed = false;
  try {
    try {
      fs.writeFileSync(fd, contents, "utf8");
      if (expected) fs.fchmodSync(fd, expected.mode & 0o7777);
    } finally {
      fs.closeSync(fd);
    }
    if (expected) assertUnchanged(expected, fs.lstatSync(file, { throwIfNoEntry: false }));
    fs.renameSync(tmp, file);
    renamed = true;
  } finally {
    if (!renamed) fs.rmSync(tmp, { force: true });
  }
  return { path: file, bytes };
}

export function assertUnchanged(expected: fs.Stats, actual: fs.Stats | undefined): void {
  if (!actual?.isFile() || expected.dev !== actual.dev || expected.ino !== actual.ino ||
      expected.size !== actual.size || expected.mtimeMs !== actual.mtimeMs ||
      expected.ctimeMs !== actual.ctimeMs || expected.mode !== actual.mode) {
    throw new ToolError("The file changed during the edit. Read it again before retrying.", "file_changed");
  }
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

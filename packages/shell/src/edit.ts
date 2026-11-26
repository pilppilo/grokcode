import fs from "node:fs";
import { diffLines } from "diff";
import { ToolError } from "grokcode-shared";

import { compareKey } from "./confine.js";
import { assertUnchanged, confineFile, writeFile, type FileContext } from "./files.js";

const fileLocks = new Map<string, Promise<void>>();
const normalize = (text: string) => text.replace(/\r\n/g, "\n");
const lineCount = (text: string) => (text.match(/\n/g)?.length ?? 0) + (text !== "" && !text.endsWith("\n") ? 1 : 0);

export async function editFile(input: string, oldText: string, newText: string, replaceAll: boolean, ctx: FileContext, signal?: AbortSignal) {
  if (oldText === "") throw new ToolError("oldText must not be empty.", "invalid_argument");
  const file = confineFile(input, ctx, undefined, false, false);
  const key = compareKey(file, ctx.platform);
  const previous = fileLocks.get(key);
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  fileLocks.set(key, ready);
  try {
    await previous;
    signal?.throwIfAborted();
    const current = confineFile(input, ctx, undefined, false, false);
    if (compareKey(current, ctx.platform) !== key) throw new ToolError("The file path changed during the edit.", "file_changed");
    const { text, stat } = readForEdit(current, ctx.policy.limits.maxReadBytes);
    const result = replaceText(text, normalize(oldText), normalize(newText), replaceAll, ctx.policy.limits.maxWriteBytes);
    const before = normalize(text);
    const after = normalize(result.text);
    const changes = diffLines(before, after, { timeout: 50, maxEditLength: 2_000 });
    const added = changes ? changes.reduce((count, part) => count + (part.added ? part.count : 0), 0) : lineCount(after);
    const removed = changes ? changes.reduce((count, part) => count + (part.removed ? part.count : 0), 0) : lineCount(before);
    const changed = result.text !== text;
    const written = changed
      ? writeFile(current, result.text, ctx, stat)
      : { path: current, bytes: stat.size };
    return {
      ...written,
      changed,
      replacements: result.replacements,
      diff: { added, removed, exact: changes !== undefined, summary: `+${added}/-${removed} lines` },
    };
  } finally {
    release();
    if (fileLocks.get(key) === ready) fileLocks.delete(key);
  }
}

function readForEdit(file: string, maxBytes: number): { text: string; stat: fs.Stats } {
  const expected = fs.lstatSync(file);
  if (!expected.isFile()) throw new ToolError("path is not a regular file.", "invalid_path");
  if (expected.size > maxBytes) throw new ToolError("File exceeds the edit read cap.", "too_large");
  const fd = fs.openSync(file, "r");
  try {
    assertUnchanged(expected, fs.fstatSync(fd));
    const buffer = Buffer.alloc(expected.size);
    for (let offset = 0; offset < buffer.length;) {
      const count = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (count === 0) throw new ToolError("The file changed during the edit.", "file_changed");
      offset += count;
    }
    assertUnchanged(expected, fs.fstatSync(fd));
    try {
      if (buffer.includes(0)) throw new Error("binary file");
      return { text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer), stat: expected };
    } catch {
      throw new ToolError("edit_file requires a UTF-8 text file.", "invalid_file");
    }
  } finally {
    fs.closeSync(fd);
  }
}

function replaceText(original: string, oldText: string, newText: string, replaceAll: boolean, maxBytes: number) {
  const normalized = normalize(original);
  let match = normalized.indexOf(oldText);
  if (match < 0) throw new ToolError("oldText was not found.", "edit_no_match");
  if (!replaceAll && normalized.indexOf(oldText, match + 1) >= 0) {
    throw new ToolError("oldText matches multiple locations. Provide more context or set replaceAll.", "edit_multiple_matches");
  }
  const crlf = original.match(/\r\n/g)?.length ?? 0;
  const newlineCount = normalized.match(/\n/g)?.length ?? 0;
  const defaultEol = crlf > newlineCount - crlf || (crlf > 0 && crlf * 2 === newlineCount && original[original.indexOf("\n") - 1] === "\r")
    ? "\r\n" : "\n";
  const parts: string[] = [];
  let bytes = 0;
  const append = (part: string) => {
    bytes += Buffer.byteLength(part);
    if (bytes > maxBytes) throw new ToolError("Edited file exceeds the write cap.", "too_large");
    parts.push(part);
  };
  let end = 0;
  let removedCRs = 0;
  let nextCR = original.indexOf("\r\n");
  const originalOffset = (target: number) => {
    while (nextCR >= 0 && nextCR - removedCRs < target) {
      removedCRs++;
      nextCR = original.indexOf("\r\n", nextCR + 2);
    }
    return target + removedCRs;
  };
  let replacements = 0;
  while (match !== -1) {
    const start = originalOffset(match);
    const index = match + oldText.length;
    const limit = originalOffset(index);
    const endings = original.slice(start, limit).match(/\r\n|\n/g) ?? [];
    let line = 0;
    append(original.slice(end, start));
    append(newText.replace(/\n/g, () => endings[line++] ?? defaultEol));
    replacements++;
    end = limit;
    match = replaceAll ? normalized.indexOf(oldText, index) : -1;
  }
  append(original.slice(end));
  return { text: parts.join(""), replacements };
}

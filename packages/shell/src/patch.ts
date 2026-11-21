import { ToolError } from "grokcode-shared";

export interface Hunk {
  oldStart: number;
  oldLines: string[];
  newLines: string[];
}

export interface FilePatch {
  oldPath: string | null;
  newPath: string | null;
  hunks: Hunk[];
}

/** Parse a unified diff. Paths keep their `a/` and `b/` prefixes until the caller strips them. */
export function parseUnifiedDiff(patch: string): FilePatch[] {
  if (patch.length === 0 || patch.length > 1_000_000) {
    throw new ToolError("patch is empty or too large.", "invalid_patch");
  }
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  const files: FilePatch[] = [];
  let current: FilePatch | undefined;
  let hunk: Hunk | undefined;
  const flushHunk = () => {
    if (hunk && current) current.hunks.push(hunk);
    hunk = undefined;
  };
  for (const line of lines) {
    if (line.startsWith("diff --git ") || line.startsWith("index ") || line.startsWith("new file") || line.startsWith("deleted file") || line.startsWith("similarity ") || line.startsWith("rename ") || line.startsWith("old mode") || line.startsWith("new mode")) {
      flushHunk();
      if (line.startsWith("diff --git ")) current = undefined;
      continue;
    }
    if (line.startsWith("--- ")) {
      flushHunk();
      current = { oldPath: diffPath(line.slice(4), "old"), newPath: null, hunks: [] };
      files.push(current);
      continue;
    }
    if (line.startsWith("+++ ")) {
      if (!current) throw new ToolError("patch has +++ without ---.", "invalid_patch");
      current.newPath = diffPath(line.slice(4), "new");
      continue;
    }
    if (line.startsWith("@@")) {
      if (!current) throw new ToolError("patch hunk is missing a file header.", "invalid_patch");
      flushHunk();
      const match = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s@@/.exec(line);
      if (!match) throw new ToolError("patch hunk header is invalid.", "invalid_patch");
      hunk = { oldStart: Number(match[1]), oldLines: [], newLines: [] };
      continue;
    }
    if (!hunk) {
      if (line === "" || line.startsWith("\\")) continue;
      continue;
    }
    if (line.startsWith("\\")) continue;
    if (line.startsWith("+")) {
      hunk.newLines.push(line.slice(1));
      continue;
    }
    if (line.startsWith("-")) {
      hunk.oldLines.push(line.slice(1));
      continue;
    }
    if (line.startsWith(" ")) {
      hunk.oldLines.push(line.slice(1));
      hunk.newLines.push(line.slice(1));
      continue;
    }
    if (line === "") continue;
    throw new ToolError("patch contains a line that is not part of a hunk.", "invalid_patch");
  }
  flushHunk();
  if (files.length === 0) throw new ToolError("patch does not contain a file.", "invalid_patch");
  return files;
}

function diffPath(raw: string, kind: "old" | "new"): string | null {
  const trimmed = raw.trim().replace(/\t.*$/, "");
  if (trimmed === "/dev/null") return null;
  let value = trimmed;
  if (kind === "old" && (value.startsWith("a/") || value.startsWith("a\\"))) value = value.slice(2);
  if (kind === "new" && (value.startsWith("b/") || value.startsWith("b\\"))) value = value.slice(2);
  if (value === "/dev/null" || value === "") return null;
  return value;
}

export function applyHunks(original: string, hunks: readonly Hunk[]): string {
  const trailingNewline = original.endsWith("\n");
  const src = original === "" ? [] : original.replace(/\n$/, "").split("\n");
  let cursor = 0;
  const out: string[] = [];
  for (const hunk of hunks) {
    const hint = Math.max(cursor, hunk.oldStart <= 0 ? 0 : hunk.oldStart - 1);
    let found = indexOfSequence(src, hunk.oldLines, Math.min(hint, src.length));
    if (found < 0) found = indexOfSequence(src, hunk.oldLines, cursor);
    if (found < 0 || found < cursor) throw new ToolError("patch context did not match.", "patch_failed");
    out.push(...src.slice(cursor, found), ...hunk.newLines);
    cursor = found + hunk.oldLines.length;
  }
  out.push(...src.slice(cursor));
  if (out.length === 0) return "";
  const text = out.join("\n");
  if (original === "" || trailingNewline) return text.endsWith("\n") ? text : `${text}\n`;
  return text;
}

function indexOfSequence(src: readonly string[], seq: readonly string[], from: number): number {
  if (seq.length === 0) return from;
  const start = Math.max(0, from);
  for (let i = start; i <= src.length - seq.length; i++) {
    let ok = true;
    for (let j = 0; j < seq.length; j++) {
      if (src[i + j] !== seq[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}

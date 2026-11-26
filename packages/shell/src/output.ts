import fs from "node:fs";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

import { ToolError } from "grokcode-shared";

import { redact } from "./redact.js";

export const DEFAULT_OUTPUT_PREVIEW_BYTES = 10 * 1024;
export const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
const MAX_LOGS = 32;
const MAX_LOG_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const logName = /^job_[0-9a-f]{24}\.log$/;

export function cleanOutput(raw: string): string {
  return redact(stripVTControlCharacters(raw))
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*/, "[REDACTED-PRIVATE-KEY]");
}

export function openOutput(directory: string, jobId: string): number {
  const file = logPath(directory, jobId);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1) throw new ToolError("Output log is unavailable.", "output_unavailable");
  const fd = fs.openSync(file, "r");
  const opened = fs.fstatSync(fd);
  if (opened.dev === stat.dev && opened.ino === stat.ino && opened.isFile()) return fd;
  fs.closeSync(fd);
  throw new ToolError("Output log is unavailable.", "output_unavailable");
}

export function saveOutput(directory: string, jobId: string, content: string): void {
  fs.mkdirSync(directory, { mode: 0o700, recursive: true });
  const file = logPath(directory, jobId);
  fs.writeFileSync(file, content, { mode: 0o600, flag: "wx" });
  try {
    const logs = fs.readdirSync(directory).filter((name) => logName.test(name) && name !== path.basename(file)).map((name) => {
      const target = path.join(directory, name);
      return { target, mtime: fs.lstatSync(target).mtimeMs };
    }).sort((a, b) => b.mtime - a.mtime);
    for (const [index, log] of logs.entries()) {
      if (index >= MAX_LOGS - 1 || Date.now() - log.mtime > MAX_LOG_AGE_MS) {
        fs.rmSync(log.target, { force: true });
      }
    }
  } catch {
    // Rotation is retried after the next completed job.
  }
}

export function logPath(directory: string, jobId: string): string {
  const name = `${jobId}.log`;
  const comparable = (input: string) => process.platform === "win32" ? input.toLowerCase() : input;
  if (!logName.test(name) || !fs.lstatSync(directory).isDirectory() ||
      comparable(fs.realpathSync(directory)) !== comparable(path.resolve(directory))) {
    throw new ToolError("Output log is unavailable.", "output_unavailable");
  }
  return path.join(directory, name);
}

import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";

import { redact } from "./redact.js";

export interface AuditEvent {
  ts: string;
  tool: string;
  decision: "allow" | "deny";
  reason?: string;
  argv?: string[];
  path?: string;
  paths?: string[];
  cwd?: string;
  jobId?: string;
}

export function auditLine(event: AuditEvent): string {
  const safe: AuditEvent = {
    ...event,
    ...(event.argv ? { argv: event.argv.map((arg) => redact(arg)) } : {}),
    ...(event.paths ? { paths: event.paths.map((item) => redact(item)) } : {}),
    ...(event.reason ? { reason: redact(event.reason) } : {}),
  };
  return JSON.stringify(safe);
}

/** Append one JSON line. A full disk must not turn a denied call into a crash. */
export function appendAudit(file: string, event: AuditEvent): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (statSync(file).size > 5_000_000) renameSync(file, `${file}.1`);
    } catch {
      /* the log does not exist yet */
    }
    appendFileSync(file, `${auditLine(event)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    /* auditing is best-effort */
  }
}

import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import path from "node:path";

import { asRecord, toolResultText } from "grokcode-shared";

import { redact } from "./redact.js";

interface AuditMetrics {
  bytesReturned: number;
  estimatedTokens: number;
  exitCode: number | null;
  durationMs: number;
  truncated: boolean;
}

export function auditMetrics(started: number, payload?: unknown): AuditMetrics {
  const result = asRecord(payload);
  const bytesReturned = Buffer.byteLength(toolResultText(payload), "utf8");
  return {
    bytesReturned,
    estimatedTokens: Math.ceil(bytesReturned / 4),
    exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
    durationMs: Math.round(performance.now() - started),
    truncated: result.truncated === true,
  };
}

export interface AuditEvent extends AuditMetrics {
  ts: string;
  tool: string;
  decision: "allow" | "deny";
  reason?: string;
  argv?: string[];
  path?: string;
  paths?: string[];
  cwd?: string;
  jobId?: string;
  sessionId: string | null;
  phase?: "admission";
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

/** Read aggregate counts from the active log and its most recent rotation. */
export function summarizeAudit(file: string) {
  const tools = new Map<string, { tool: string; calls: number; denials: number; bytesReturned: number }>();
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, calls: 0 }));
  for (const log of [`${file}.1`, file]) {
    let content: string;
    try {
      content = readFileSync(log, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let event: Record<string, unknown>;
      try {
        event = asRecord(JSON.parse(line));
      } catch {
        continue;
      }
      const { tool, decision, bytesReturned, ts } = event;
      if (event.phase === "admission" || typeof tool !== "string" || (decision !== "allow" && decision !== "deny")) continue;
      const totals = tools.get(tool) ?? { tool, calls: 0, denials: 0, bytesReturned: 0 };
      totals.calls++;
      if (decision === "deny") totals.denials++;
      if (typeof bytesReturned === "number" && Number.isSafeInteger(bytesReturned) && bytesReturned >= 0) {
        totals.bytesReturned += bytesReturned;
      }
      tools.set(tool, totals);
      const hour = typeof ts === "string" ? hours[new Date(ts).getUTCHours()] : undefined;
      if (hour) hour.calls++;
    }
  }
  return {
    tools: [...tools.values()].sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool)),
    busiestHoursUtc: hours.filter(({ calls }) => calls > 0).sort((a, b) => b.calls - a.calls || a.hour - b.hour),
  };
}

/** Append one JSON line. A full disk must not turn a denied call into a crash. */
export function appendAudit(file: string, event: AuditEvent): boolean {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (statSync(file).size > 5_000_000) renameSync(file, `${file}.1`);
    } catch {
      /* the log does not exist yet */
    }
    appendFileSync(file, `${auditLine(event)}\n`, { encoding: "utf8", mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

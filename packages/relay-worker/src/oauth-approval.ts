const transactionLimit = 3;
const globalLimit = 10;
const hour = 60 * 60 * 1000;
const failureKey = "approval:failures";

export type ApprovalAttempt =
  | { status: "approved"; value: string }
  | { status: "expired" | "rejected" | "locked" };

interface ApprovalRows {
  get(key: string): { value: string; expiresAt?: number | null } | undefined;
  put(key: string, value: string, expiresAt: number): void;
  delete(key: string): void;
}

/** Run inside a single synchronous storage transaction. */
export function applyApprovalAttempt(rows: ApprovalRows, key: string, matches: boolean, now: number): ApprovalAttempt {
  const window = rows.get(failureKey);
  const activeWindow = window?.expiresAt != null && window.expiresAt > now ? window : undefined;
  const failures = Number(activeWindow?.value ?? 0);
  if (failures >= globalLimit) return { status: "locked" };

  const row = rows.get(key);
  if (!row || row.expiresAt == null || row.expiresAt <= now) return { status: "expired" };
  let txn: { approvalFailures?: number };
  try {
    const parsed: unknown = JSON.parse(row.value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { status: "expired" };
    txn = parsed;
  } catch {
    return { status: "expired" };
  }
  if (matches) {
    rows.delete(key);
    return { status: "approved", value: row.value };
  }

  const attempts = (txn.approvalFailures ?? 0) + 1;
  if (attempts >= transactionLimit) rows.delete(key);
  else rows.put(key, JSON.stringify({ ...txn, approvalFailures: attempts }), row.expiresAt);

  const count = failures + 1;
  const expiresAt = count >= globalLimit ? now + hour : activeWindow?.expiresAt ?? now + hour;
  rows.put(failureKey, String(count), expiresAt);
  return { status: "rejected" };
}

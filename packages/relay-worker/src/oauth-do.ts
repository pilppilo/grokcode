import { DurableObject } from "cloudflare:workers";

import type { Env } from "./env.js";
import { applyApprovalAttempt } from "./oauth-approval.js";

/**
 * SQLite-backed OAuth state. One object holds every dynamic client, code, and token.
 * Values are hashes or JSON records, never logged.
 */
export class OAuthStoreDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS oauth_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER)",
      );
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    let body: { key?: string; value?: string; expiresAt?: number | null; quota?: number; matches?: boolean } = {};
    try {
      body = (await request.json()) as typeof body;
    } catch {
      body = {};
    }
    const key = body.key ?? "";
    if (!key || key.length > 300) return Response.json({ error: "bad key" }, { status: 400 });
    if (url.pathname === "/approve-attempt") {
      const { matches } = body;
      if (!/^txn:[A-Za-z0-9_-]{32}$/.test(key) || typeof matches !== "boolean") {
        return Response.json({ error: "bad approval" }, { status: 400 });
      }
      const sql = this.ctx.storage.sql;
      const result = this.ctx.storage.transactionSync(() => applyApprovalAttempt({
        get: (key) => sql.exec<{ value: string; expiresAt: number | null }>(
          "SELECT value, expires_at AS expiresAt FROM oauth_kv WHERE key = ?", key,
        ).toArray()[0],
        put: (key, value, expiresAt) => {
          sql.exec("INSERT OR REPLACE INTO oauth_kv (key, value, expires_at) VALUES (?, ?, ?)", key, value, expiresAt);
        },
        delete: (key) => { sql.exec("DELETE FROM oauth_kv WHERE key = ?", key); },
      }, key, matches, Date.now()));
      return Response.json(result);
    }
    if (url.pathname === "/register-client") {
      const { value, expiresAt, quota } = body;
      const now = Date.now();
      if (!key.startsWith("client:") || typeof value !== "string" ||
        typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt <= now ||
        typeof quota !== "number" || !Number.isSafeInteger(quota) || quota < 0) {
        return Response.json({ error: "bad registration" }, { status: 400 });
      }
      const sql = this.ctx.storage.sql;
      sql.exec("DELETE FROM oauth_kv WHERE expires_at IS NOT NULL AND expires_at <= ?", now);
      const inserted = sql.exec<{ key: string }>(
        `INSERT INTO oauth_kv (key, value, expires_at)
         SELECT ?, ?, ?
         WHERE (SELECT COUNT(*) FROM oauth_kv WHERE key GLOB 'client:*') < ?
         ON CONFLICT(key) DO NOTHING
         RETURNING key`,
        key, value, expiresAt, quota,
      ).toArray().length > 0;
      return Response.json({ inserted });
    }
    if (url.pathname === "/get") {
      const rows = this.ctx.storage.sql
        .exec<{ value: string; expires_at: number | null }>("SELECT value, expires_at FROM oauth_kv WHERE key = ?", key)
        .toArray();
      const row = rows[0];
      if (!row) return Response.json({ value: null });
      if (row.expires_at != null && row.expires_at <= Date.now()) {
        this.ctx.storage.sql.exec("DELETE FROM oauth_kv WHERE key = ?", key);
        return Response.json({ value: null });
      }
      return Response.json({ value: row.value });
    }
    if (url.pathname === "/put") {
      this.ctx.storage.sql.exec("DELETE FROM oauth_kv WHERE expires_at IS NOT NULL AND expires_at <= ?", Date.now());
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO oauth_kv (key, value, expires_at) VALUES (?, ?, ?)",
        key,
        body.value ?? "",
        body.expiresAt ?? null,
      );
      return Response.json({ ok: true });
    }
    if (url.pathname === "/delete") {
      this.ctx.storage.sql.exec("DELETE FROM oauth_kv WHERE key = ?", key);
      return Response.json({ ok: true });
    }
    if (url.pathname === "/take") {
      const rows = this.ctx.storage.sql
        .exec<{ value: string; expires_at: number | null }>(
          "DELETE FROM oauth_kv WHERE key = ? RETURNING value, expires_at",
          key,
        )
        .toArray();
      const row = rows[0];
      if (!row || (row.expires_at != null && row.expires_at <= Date.now())) return Response.json({ value: null });
      return Response.json({ value: row.value });
    }
    return new Response("not found", { status: 404 });
  }
}

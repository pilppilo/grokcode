import { DurableObject } from "cloudflare:workers";

import type { Env } from "./env.js";

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
    let body: { key?: string; value?: string; expiresAt?: number | null } = {};
    try {
      body = (await request.json()) as typeof body;
    } catch {
      body = {};
    }
    const key = body.key ?? "";
    if (!key || key.length > 300) return Response.json({ error: "bad key" }, { status: 400 });
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
    return new Response("not found", { status: 404 });
  }
}

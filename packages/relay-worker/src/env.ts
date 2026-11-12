export interface Env {
  HUB: DurableObjectNamespace;
  /** Bearer token Grok Bot sends as `Authorization: Bearer …`. Wrangler secret. */
  MCP_TOKEN?: string;
  /** JSON object of machine name → token. Wrangler secret. */
  MACHINE_TOKENS?: string;
  MAX_SYNC_WAIT_MS?: string;
}

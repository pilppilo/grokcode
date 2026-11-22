export interface Env {
  HUB: DurableObjectNamespace;
  /** OAuth client registrations, codes, and access tokens for the Gemini shell endpoint. */
  OAUTH: DurableObjectNamespace;
  /** Bearer token Grok Bot sends as `Authorization: Bearer …`. Wrangler secret. */
  MCP_TOKEN?: string;
  /** JSON object of machine name → token. Wrangler secret. */
  MACHINE_TOKENS?: string;
  MAX_SYNC_WAIT_MS?: string;
  /** Comma-separated Google accounts allowed to complete the shell OAuth flow. */
  OWNER_EMAILS?: string;
  /** Single-owner approval secret used when Google sign-in is not configured. At least 16 characters. Approval-secret mode also requires OWNER_EMAILS. */
  OWNER_APPROVAL_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Optional pre-registered OAuth clients. JSON array of { clientId, clientSecret, redirectUris }. */
  OAUTH_CLIENTS?: string;
  /**
   * Public origin clients use, when the request host is not that URL.
   * Set this on Cloudflare when the worker hostname is not the URL Gemini registered.
   */
  PUBLIC_ORIGIN?: string;
  /**
   * Optional exact redirect URIs, comma-separated.
   */
  OAUTH_PINNED_REDIRECTS?: string;
}

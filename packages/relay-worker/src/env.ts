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
  /** Single-owner approval secret used when Google sign-in is not configured. At least 16 characters. */
  OWNER_APPROVAL_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Optional pre-registered OAuth clients. JSON array of { clientId, clientSecret, redirectUris }. */
  OAUTH_CLIENTS?: string;
  /** Override the public origin when the request host is not the URL clients use. */
  PUBLIC_ORIGIN?: string;
}

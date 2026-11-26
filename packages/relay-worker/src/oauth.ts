import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { MIN_TOKEN_LENGTH, tokensEqual } from "grokcode-shared";
import { applyApprovalAttempt, type ApprovalAttempt } from "./oauth-approval.js";

/** MCP path Gemini and Antigravity call. OAuth tokens are only valid for this resource. */
export const GEMINI_MCP_PATH = "/gemini/mcp";

const ACCESS_TTL_MS = 60 * 60 * 1000;
/** Absolute lifetime from creation. Refresh returns the same token and does not extend this. */
const REFRESH_MAX_MS = 90 * 24 * 60 * 60 * 1000;
const CODE_TTL_MS = 60 * 1000;
const TXN_TTL_MS = 10 * 60 * 1000;
const CLIENT_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const DEFAULT_REGISTRATION_QUOTA = 50;

const GOOGLE_REDIRECT_HOSTS = new Set([
  "oauth-redirect.googleusercontent.com",
  "oauth-redirect-sandbox.googleusercontent.com",
  "oauth-redirect-test.googleusercontent.com",
]);

export interface OAuthStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, expiresAt?: number): Promise<void>;
  delete(key: string): Promise<void>;
  /** Delete the key and return its previous value. One atomic step, so two redemptions cannot both succeed. */
  take(key: string): Promise<string | null>;
  /** Insert a dynamic client only if the active-client quota has room. */
  registerClient(key: string, value: string, expiresAt: number, quota: number): Promise<boolean>;
  approveAttempt(key: string, matches: boolean): Promise<ApprovalAttempt>;
}

export class MemoryOAuthStore implements OAuthStore {
  private readonly rows = new Map<string, { value: string; expiresAt?: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  async get(key: string): Promise<string | null> {
    const row = this.rows.get(key);
    if (!row) return null;
    if (row.expiresAt != null && row.expiresAt <= this.now()) {
      this.rows.delete(key);
      return null;
    }
    return row.value;
  }

  async put(key: string, value: string, expiresAt?: number): Promise<void> {
    this.rows.set(key, expiresAt == null ? { value } : { value, expiresAt });
  }

  async delete(key: string): Promise<void> {
    this.rows.delete(key);
  }

  async take(key: string): Promise<string | null> {
    const row = this.rows.get(key);
    if (!row) return null;
    this.rows.delete(key);
    if (row.expiresAt != null && row.expiresAt <= this.now()) return null;
    return row.value;
  }

  async registerClient(key: string, value: string, expiresAt: number, quota: number): Promise<boolean> {
    const now = this.now();
    let active = 0;
    for (const [key, row] of this.rows) {
      if (row.expiresAt != null && row.expiresAt <= now) this.rows.delete(key);
      else if (key.startsWith("client:")) active++;
    }
    if (active >= quota || this.rows.has(key)) return false;
    this.rows.set(key, { value, expiresAt });
    return true;
  }

  async approveAttempt(key: string, matches: boolean): Promise<ApprovalAttempt> {
    return applyApprovalAttempt({
      get: (key) => this.rows.get(key),
      put: (key, value, expiresAt) => { this.rows.set(key, { value, expiresAt }); },
      delete: (key) => { this.rows.delete(key); },
    }, key, matches, this.now());
  }
}

export interface StaticClient {
  clientId: string;
  clientSecret: string;
  redirectUris: string[];
}

export interface IdentityProfile {
  email: string;
  sub: string;
  emailVerified: boolean;
}

export interface IdentityProvider {
  authorizationUrl(input: { redirectUri: string; state: string }): string;
  exchange(input: { code: string; redirectUri: string }): Promise<IdentityProfile>;
}

export interface OAuthConfig {
  store: OAuthStore;
  ownerEmails?: string[];
  approvalSecret?: string;
  staticClients?: StaticClient[];
  identity?: IdentityProvider;
  google?: { clientId: string; clientSecret: string };
  publicOrigin?: string;
  /** Optional exact redirect URIs for registration and authorization. */
  pinnedRedirects?: string[];
  /** Cap on dynamic client registrations stored by this worker. Default 50. */
  registrationQuota?: number;
  now?: () => number;
  fetchImpl?: typeof fetch;
}

interface OAuthRuntime {
  issuer: string;
  resource: string;
  store: OAuthStore;
  ownerEmails: string[];
  approvalSecret?: string;
  staticClients: StaticClient[];
  identity?: IdentityProvider;
  pinnedRedirects: string[];
  registrationQuota: number;
  now: () => number;
}

interface StoredClient {
  clientId: string;
  secretHash?: string;
  redirectUris: string[];
  authMethod: "none" | "client_secret_basic" | "client_secret_post";
  clientName?: string;
  expiresAt: number;
}

interface Txn {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  clientState: string;
  scope: string;
  expiresAt: number;
}

interface AuthCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  email: string;
  scope: string;
  expiresAt: number;
}

interface RefreshRow {
  clientId: string;
  email: string;
  scope: string;
  createdAt: number;
  expiresAt: number;
}

interface AccessRow {
  refreshHash?: string;
  clientId: string;
  email: string;
  scope: string;
  resource: string;
  expiresAt: number;
}

interface Consent extends Txn {
  email: string;
  csrf: string;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

export function pkceS256(verifier: string): string {
  return sha256(verifier);
}

export function redirectUriAllowed(uri: string, pinned?: readonly string[]): boolean {
  if (!validRedirectUri(uri)) return false;
  if (pinned?.length) return pinned.includes(uri);
  const url = new URL(uri);
  // Google documents all six Connected Apps callbacks (three hosts, /r/ and /a/) as official.
  return url.protocol === "https:" && url.port === "" && GOOGLE_REDIRECT_HOSTS.has(url.hostname);
}

function validRedirectUri(uri: string): boolean {
  if (uri.includes("#") || uri.includes("\\") || /\s/.test(uri)) return false;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.username || url.password || url.hash) return false;
  if (url.protocol === "https:" && GOOGLE_REDIRECT_HOSTS.has(url.hostname)) {
    // Gemini Custom Apps uses /r/<app> and Antigravity-style clients use /a/<app>.
    return url.pathname.startsWith("/r/") || url.pathname.startsWith("/a/");
  }
  if ((url.protocol === "http:" || url.protocol === "https:") && (url.hostname === "localhost" || url.hostname === "127.0.0.1")) {
    return true;
  }
  return false;
}

export function parseOwnerEmails(raw: string | undefined): string[] {
  if (!raw || raw.trim() === "") return [];
  return raw
    .split(/[,\s]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export function parseStaticClients(raw: string | undefined): StaticClient[] {
  if (!raw || raw.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("OAUTH_CLIENTS is not valid JSON.");
  }
  if (!Array.isArray(parsed)) throw new Error("OAUTH_CLIENTS must be a JSON array.");
  return parsed.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("OAUTH_CLIENTS has an invalid entry.");
    const record = entry as Record<string, unknown>;
    const clientId = record.clientId;
    const clientSecret = record.clientSecret;
    const redirectUris = record.redirectUris;
    if (typeof clientId !== "string" || !/^[A-Za-z0-9._-]{8,128}$/.test(clientId)) {
      throw new Error("OAUTH_CLIENTS clientId is invalid.");
    }
    if (typeof clientSecret !== "string" || clientSecret.length < MIN_TOKEN_LENGTH) {
      throw new Error(`OAUTH_CLIENTS secret for "${clientId}" must be at least ${MIN_TOKEN_LENGTH} characters.`);
    }
    if (
      !Array.isArray(redirectUris) ||
      redirectUris.length === 0 ||
      redirectUris.some((item) => typeof item !== "string" || !validRedirectUri(item))
    ) {
      throw new Error(`OAUTH_CLIENTS redirect URIs for "${clientId}" are missing or not on the allowlist.`);
    }
    return { clientId, clientSecret, redirectUris: redirectUris as string[] };
  });
}

export function emailAllowed(email: string, ownerEmails: readonly string[]): boolean {
  const needle = email.trim().toLowerCase();
  if (!needle.includes("@")) return false;
  return ownerEmails.some((item) => item.toLowerCase() === needle);
}

/** Google sign-in. The Worker exchanges the code and reads userinfo; only a verified allowlisted email continues. */
export function googleIdentity(clientId: string, clientSecret: string, fetchImpl: typeof fetch = fetch): IdentityProvider {
  return {
    authorizationUrl({ redirectUri, state }) {
      const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", "openid email");
      url.searchParams.set("state", state);
      url.searchParams.set("prompt", "select_account");
      return url.toString();
    },
    async exchange({ code, redirectUri }) {
      const body = new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      });
      const tokenRes = await fetchImpl("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body,
      });
      if (!tokenRes.ok) throw new Error("Google token exchange failed.");
      const tokenJson = (await tokenRes.json()) as { access_token?: string };
      if (!tokenJson.access_token) throw new Error("Google token exchange failed.");
      const infoRes = await fetchImpl("https://openidconnect.googleapis.com/v1/userinfo", {
        headers: { authorization: `Bearer ${tokenJson.access_token}`, accept: "application/json" },
      });
      if (!infoRes.ok) throw new Error("Google userinfo failed.");
      const info = (await infoRes.json()) as { email?: string; sub?: string; email_verified?: boolean | string };
      if (!info.email || !info.sub) throw new Error("Google did not return an email.");
      return {
        email: info.email,
        sub: info.sub,
        emailVerified: info.email_verified === true || info.email_verified === "true",
      };
    },
  };
}

export function isOAuthPath(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, "") || "/";
  return (
    path === "/.well-known/oauth-authorization-server" ||
    path === "/.well-known/oauth-protected-resource" ||
    path === "/.well-known/oauth-protected-resource/gemini/mcp" ||
    path === "/oauth/register" ||
    path === "/oauth/authorize" ||
    path === "/oauth/token" ||
    path === "/oauth/revoke" ||
    path === "/oauth/google/callback"
  );
}

export function wwwAuthenticate(origin: string, error?: "invalid_token" | "invalid_request"): string {
  const metadata = `${origin.replace(/\/$/, "")}/.well-known/oauth-protected-resource/gemini/mcp`;
  const parts = ['Bearer realm="grokcode-shell"'];
  if (error) parts.push(`error="${error}"`);
  parts.push(`resource_metadata="${metadata}"`);
  return parts.join(", ");
}

export function runtimeFromRequest(request: Request, config: OAuthConfig): OAuthRuntime {
  const origin = (config.publicOrigin || new URL(request.url).origin).replace(/\/$/, "");
  const identity =
    config.identity ??
    (config.google ? googleIdentity(config.google.clientId, config.google.clientSecret, config.fetchImpl) : undefined);
  // Google sign-in is the owner gate. The approval secret must not bypass it.
  const approval =
    !identity && config.approvalSecret && config.approvalSecret.length >= MIN_TOKEN_LENGTH ? config.approvalSecret : undefined;
  const pinned = (config.pinnedRedirects ?? []).map((item) => item.trim()).filter(Boolean);
  return {
    issuer: origin,
    resource: `${origin}${GEMINI_MCP_PATH}`,
    store: config.store,
    ownerEmails: (config.ownerEmails ?? []).map((item) => item.toLowerCase()),
    ...(approval ? { approvalSecret: approval } : {}),
    staticClients: config.staticClients ?? [],
    ...(identity ? { identity } : {}),
    pinnedRedirects: pinned,
    registrationQuota: config.registrationQuota ?? DEFAULT_REGISTRATION_QUOTA,
    now: config.now ?? Date.now,
  };
}

export async function handleOAuthRequest(request: Request, config: OAuthConfig): Promise<Response> {
  const runtime = runtimeFromRequest(request, config);
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (request.method === "OPTIONS" && isOAuthPath(path)) {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "Authorization, Content-Type",
      },
    });
  }
  try {
    if (request.method === "GET" && path === "/.well-known/oauth-authorization-server") return metadata(runtime);
    if (
      request.method === "GET" &&
      (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/gemini/mcp")
    ) {
      return resourceMetadata(runtime);
    }
    if (path === "/oauth/register") return register(request, runtime);
    if (path === "/oauth/authorize") return authorize(request, url, runtime);
    if (path === "/oauth/token") return token(request, runtime);
    if (path === "/oauth/revoke") return revoke(request, runtime);
    if (path === "/oauth/google/callback") return googleCallback(url, runtime);
  } catch (err) {
    const message = err instanceof Error ? err.message : "oauth error";
    return oauthJson({ error: "invalid_request", error_description: message }, 400);
  }
  return new Response("not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
}

export async function accessTokenSubject(
  token: string,
  config: OAuthConfig,
  request: Request,
): Promise<{ email: string; clientId: string } | null> {
  if (!token || token.length < 20) return null;
  const runtime = runtimeFromRequest(request, config);
  const raw = await runtime.store.get(`access:${sha256(token)}`);
  if (!raw) return null;
  let row: AccessRow;
  try {
    row = JSON.parse(raw) as AccessRow;
  } catch {
    return null;
  }
  if (row.expiresAt <= runtime.now()) return null;
  if (row.resource !== runtime.resource) return null;
  if (row.refreshHash && await runtime.store.get(`revoked:${row.refreshHash}`)) return null;
  if (!emailAllowed(row.email, runtime.ownerEmails)) return null;
  return { email: row.email, clientId: row.clientId };
}

function metadata(runtime: OAuthRuntime): Response {
  return oauthJson({
    issuer: runtime.issuer,
    authorization_endpoint: `${runtime.issuer}/oauth/authorize`,
    token_endpoint: `${runtime.issuer}/oauth/token`,
    revocation_endpoint: `${runtime.issuer}/oauth/revoke`,
    revocation_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
    registration_endpoint: `${runtime.issuer}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
    scopes_supported: ["shell"],
  });
}

function resourceMetadata(runtime: OAuthRuntime): Response {
  return oauthJson({
    resource: runtime.resource,
    authorization_servers: [runtime.issuer],
    scopes_supported: ["shell"],
    bearer_methods_supported: ["header"],
    resource_name: "grokcode shell",
  });
}

async function register(request: Request, runtime: OAuthRuntime): Promise<Response> {
  if (request.method !== "POST") return oauthJson({ error: "invalid_request" }, 405);
  const body = await readJson(request);
  const redirects = stringArray(body.redirect_uris);
  if (redirects.length === 0 || redirects.length > 8 || redirects.some((uri) => !redirectUriAllowed(uri, runtime.pinnedRedirects))) {
    return oauthJson({ error: "invalid_client_metadata", error_description: "redirect_uris are missing or not allowed." }, 400);
  }
  const requestedMethod = typeof body.token_endpoint_auth_method === "string" ? body.token_endpoint_auth_method : "client_secret_basic";
  if (requestedMethod !== "none" && requestedMethod !== "client_secret_basic" && requestedMethod !== "client_secret_post") {
    return oauthJson({ error: "invalid_client_metadata", error_description: "unsupported token endpoint auth method." }, 400);
  }
  const grants = body.grant_types == null ? ["authorization_code", "refresh_token"] : stringArray(body.grant_types);
  if (grants.some((grant) => grant !== "authorization_code" && grant !== "refresh_token")) {
    return oauthJson({ error: "invalid_client_metadata", error_description: "unsupported grant type." }, 400);
  }
  const responses = body.response_types == null ? ["code"] : stringArray(body.response_types);
  if (responses.length !== 1 || responses[0] !== "code") {
    return oauthJson({ error: "invalid_client_metadata", error_description: "only response type code is supported." }, 400);
  }
  const clientName = typeof body.client_name === "string" ? body.client_name.slice(0, 120) : undefined;
  const clientId = `gmc_${randomUrlToken(18)}`;
  const secret = requestedMethod === "none" ? undefined : randomUrlToken(32);
  const expiresAt = runtime.now() + CLIENT_TTL_MS;
  const stored: StoredClient = {
    clientId,
    ...(secret ? { secretHash: sha256(secret) } : {}),
    redirectUris: redirects,
    authMethod: requestedMethod,
    ...(clientName ? { clientName } : {}),
    expiresAt,
  };
  if (!await runtime.store.registerClient(`client:${clientId}`, JSON.stringify(stored), expiresAt, runtime.registrationQuota)) {
    return oauthJson({ error: "invalid_client_metadata", error_description: "dynamic client registration quota exceeded." }, 429);
  }
  return oauthJson(
    {
      client_id: clientId,
      ...(secret ? { client_secret: secret, client_secret_expires_at: Math.floor(expiresAt / 1000) } : {}),
      client_id_issued_at: Math.floor(runtime.now() / 1000),
      redirect_uris: redirects,
      grant_types: grants,
      response_types: ["code"],
      token_endpoint_auth_method: requestedMethod,
      ...(clientName ? { client_name: clientName } : {}),
    },
    201,
  );
}

async function authorize(request: Request, url: URL, runtime: OAuthRuntime): Promise<Response> {
  if (request.method === "POST") return approve(request, runtime);
  if (request.method !== "GET") return oauthJson({ error: "invalid_request" }, 405);
  const params = url.searchParams;
  if (params.get("response_type") !== "code") return oauthJson({ error: "unsupported_response_type" }, 400);
  const client = await findClient(runtime, params.get("client_id") ?? "");
  if (!client) return oauthJson({ error: "invalid_client" }, 401);
  const redirectUri = params.get("redirect_uri") ?? "";
  if (!client.redirectUris.includes(redirectUri) || !redirectUriAllowed(redirectUri, runtime.pinnedRedirects)) {
    return oauthJson({ error: "invalid_request", error_description: "redirect_uri is not registered." }, 400);
  }
  if (params.get("code_challenge_method") !== "S256") {
    return oauthJson({ error: "invalid_request", error_description: "PKCE S256 is required." }, 400);
  }
  const challenge = params.get("code_challenge") ?? "";
  if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) return oauthJson({ error: "invalid_request", error_description: "code_challenge is invalid." }, 400);
  const state = params.get("state") ?? "";
  if (state.length === 0) {
    return oauthJson({ error: "invalid_request", error_description: "state is required." }, 400);
  }
  if (state.length > 8192 || /[\r\n]/.test(state)) {
    return oauthJson({ error: "invalid_request", error_description: "state is invalid." }, 400);
  }
  const scope = params.get("scope")?.trim() || "shell";
  if (scope.split(/\s+/).some((item) => item !== "shell" && item !== "offline_access")) {
    return oauthJson({ error: "invalid_scope" }, 400);
  }
  const resource = params.get("resource");
  if (resource && resource !== runtime.resource && resource !== `${runtime.resource}/`) {
    return oauthJson({ error: "invalid_target", error_description: "resource does not match this server." }, 400);
  }
  if (!runtime.identity && (!runtime.approvalSecret || runtime.ownerEmails.length === 0)) {
    return html(
      "Owner sign-in is not configured. Approval-secret mode needs OWNER_EMAILS and an OWNER_APPROVAL_SECRET of at least 16 characters. Google sign-in needs OWNER_EMAILS plus Google credentials.",
      503,
    );
  }
  const txnId = randomUrlToken(24);
  const txn: Txn = {
    clientId: client.clientId,
    redirectUri,
    codeChallenge: challenge,
    clientState: state,
    scope: "shell",
    expiresAt: runtime.now() + TXN_TTL_MS,
  };
  await runtime.store.put(`txn:${txnId}`, JSON.stringify(txn), txn.expiresAt);
  if (runtime.identity) {
    const location = runtime.identity.authorizationUrl({
      redirectUri: `${runtime.issuer}/oauth/google/callback`,
      state: txnId,
    });
    return redirect(location);
  }
  return htmlDocument(approvalPage(txnId, client.clientId, client.clientName ?? client.clientId, redirectUri), 200);
}

async function approve(request: Request, runtime: OAuthRuntime): Promise<Response> {
  const form = await readForm(request);
  if (form.get("csrf") != null) return submitConsent(runtime, form);
  if (!runtime.approvalSecret || runtime.identity) return html("Owner approval is not configured.", 503);
  const txnId = form.get("txn") ?? "";
  const secret = form.get("secret") ?? "";
  const email = runtime.ownerEmails[0];
  if (!email) return html("Set OWNER_EMAILS to use the approval secret.", 503);
  if (!/^[A-Za-z0-9_-]{32}$/.test(txnId)) return html("This approval request expired. Start the connection again.", 400);
  const attempt = await runtime.store.approveAttempt(`txn:${txnId}`, tokensEqual(runtime.approvalSecret, secret));
  if (attempt.status === "locked") return html("Owner approval is temporarily locked after too many failed attempts.", 429);
  if (attempt.status === "rejected") return html("Approval rejected.", 403);
  if (attempt.status !== "approved") return html("This approval request expired. Start the connection again.", 400);
  return finish(runtime, JSON.parse(attempt.value) as Txn, email);
}

async function submitConsent(runtime: OAuthRuntime, form: URLSearchParams): Promise<Response> {
  const consentId = form.get("consent") ?? "";
  const csrf = form.get("csrf") ?? "";
  const row = await takeJson<Consent>(runtime, `consent:${consentId}`);
  if (!row || row.expiresAt <= runtime.now() || !safeEqual(row.csrf, csrf)) {
    return html("This approval request expired. Start the connection again.", 400);
  }
  if (!emailAllowed(row.email, runtime.ownerEmails)) return html("This account cannot use this relay.", 403);
  return finish(runtime, row, row.email);
}

async function googleCallback(url: URL, runtime: OAuthRuntime): Promise<Response> {
  if (!runtime.identity) return html("Google sign-in is not configured.", 404);
  const txn = await takeJson<Txn>(runtime, `txn:${url.searchParams.get("state") ?? ""}`);
  if (!txn) return html("This sign-in expired. Start the connection again.", 400);
  const code = url.searchParams.get("code");
  if (!code) return html("Google did not return a code.", 400);
  let profile: IdentityProfile;
  try {
    profile = await runtime.identity.exchange({ code, redirectUri: `${runtime.issuer}/oauth/google/callback` });
  } catch {
    return html("Google sign-in failed.", 502);
  }
  if (!profile.emailVerified || !emailAllowed(profile.email, runtime.ownerEmails)) {
    return html(
      `Signed in as ${escapeHtml(profile.email)}, which is not the owner of this relay. No token was issued.`,
      403,
    );
  }
  const client = await findClient(runtime, txn.clientId);
  const csrf = randomUrlToken(24);
  const consentId = randomUrlToken(18);
  const consent: Consent = {
    ...txn,
    email: profile.email.toLowerCase(),
    csrf,
    expiresAt: runtime.now() + TXN_TTL_MS,
  };
  await runtime.store.put(`consent:${consentId}`, JSON.stringify(consent), consent.expiresAt);
  return htmlDocument(
    consentPage(consentId, csrf, client?.clientId ?? txn.clientId, client?.clientName ?? txn.clientId, txn.redirectUri),
    200,
  );
}

async function finish(runtime: OAuthRuntime, txn: Txn, email: string): Promise<Response> {
  if (!emailAllowed(email, runtime.ownerEmails)) return html("This account cannot use this relay.", 403);
  if (!redirectUriAllowed(txn.redirectUri, runtime.pinnedRedirects)) return html("Callback is no longer allowed.", 400);
  const code = randomUrlToken(32);
  const row: AuthCode = {
    clientId: txn.clientId,
    redirectUri: txn.redirectUri,
    codeChallenge: txn.codeChallenge,
    email,
    scope: txn.scope,
    expiresAt: runtime.now() + CODE_TTL_MS,
  };
  await runtime.store.put(`code:${sha256(code)}`, JSON.stringify(row), row.expiresAt);
  const target = new URL(txn.redirectUri);
  target.searchParams.set("code", code);
  target.searchParams.set("state", txn.clientState);
  return redirect(target.toString());
}

async function token(request: Request, runtime: OAuthRuntime): Promise<Response> {
  if (request.method !== "POST") return oauthJson({ error: "invalid_request" }, 405);
  const form = await readForm(request);
  const grant = form.get("grant_type");
  const presented = await presentedClient(request, form);
  if (!presented) return oauthJson({ error: "invalid_client" }, 401);
  const client = await findClient(runtime, presented.clientId);
  if (!client || client.expiresAt <= runtime.now()) return oauthJson({ error: "invalid_client" }, 401);
  if (!clientAuthenticated(client, presented.secret)) return oauthJson({ error: "invalid_client" }, 401);
  if (grant === "authorization_code") return exchangeCode(runtime, client, form);
  if (grant === "refresh_token") return exchangeRefresh(runtime, client, form);
  return oauthJson({ error: "unsupported_grant_type" }, 400);
}

async function revoke(request: Request, runtime: OAuthRuntime): Promise<Response> {
  if (request.method !== "POST") return oauthJson({ error: "invalid_request" }, 405);
  const form = await readForm(request);
  const presented = await presentedClient(request, form);
  const client = presented && await findClient(runtime, presented.clientId);
  if (!presented || !client || client.expiresAt <= runtime.now() || !clientAuthenticated(client, presented.secret)) {
    return oauthJson({ error: "invalid_client" }, 401);
  }
  const token = form.get("token");
  if (!token) return oauthJson({ error: "invalid_request" }, 400);
  const hash = sha256(token);
  const refresh = await runtime.store.get(`refresh:${hash}`);
  if (refresh && (JSON.parse(refresh) as RefreshRow).clientId === client.clientId) {
    await revokeGrant(runtime, hash);
  } else {
    const raw = await runtime.store.get(`access:${hash}`);
    const access = raw ? (JSON.parse(raw) as AccessRow) : null;
    if (access?.clientId === client.clientId) {
      if (access.refreshHash) await revokeGrant(runtime, access.refreshHash);
      await runtime.store.delete(`access:${hash}`);
    }
  }
  return new Response(null, { headers: { "access-control-allow-origin": "*", "cache-control": "no-store" } });
}

async function revokeGrant(runtime: OAuthRuntime, hash: string): Promise<void> {
  // Keep a marker so an in-flight refresh cannot restore a usable grant.
  await runtime.store.put(`revoked:${hash}`, "1", runtime.now() + REFRESH_MAX_MS + ACCESS_TTL_MS);
  await runtime.store.delete(`refresh:${hash}`);
}

async function exchangeCode(runtime: OAuthRuntime, client: StoredClient, form: URLSearchParams): Promise<Response> {
  const code = form.get("code") ?? "";
  const redirectUri = form.get("redirect_uri") ?? "";
  const verifier = form.get("code_verifier") ?? "";
  const row = await takeJson<AuthCode>(runtime, `code:${sha256(code)}`);
  if (!row || row.clientId !== client.clientId || row.redirectUri !== redirectUri || !redirectUriAllowed(redirectUri, runtime.pinnedRedirects)) {
    return oauthJson({ error: "invalid_grant" }, 400);
  }
  if (!pkceOk(verifier, row.codeChallenge)) return oauthJson({ error: "invalid_grant", error_description: "PKCE verification failed." }, 400);
  if (!emailAllowed(row.email, runtime.ownerEmails)) return oauthJson({ error: "access_denied" }, 403);
  return issueTokens(runtime, client.clientId, row.email, row.scope);
}

async function exchangeRefresh(runtime: OAuthRuntime, client: StoredClient, form: URLSearchParams): Promise<Response> {
  const refresh = form.get("refresh_token") ?? "";
  const hash = sha256(refresh);
  if (await runtime.store.get(`revoked:${hash}`)) return oauthJson({ error: "invalid_grant" }, 400);
  const raw = await runtime.store.get(`refresh:${hash}`);
  const row = raw ? (JSON.parse(raw) as RefreshRow) : null;
  if (!row || row.clientId !== client.clientId) return oauthJson({ error: "invalid_grant" }, 400);
  const createdAt = typeof row.createdAt === "number" ? row.createdAt : row.expiresAt - REFRESH_MAX_MS;
  if (createdAt + REFRESH_MAX_MS <= runtime.now()) return oauthJson({ error: "invalid_grant" }, 400);
  if (!emailAllowed(row.email, runtime.ownerEmails)) return oauthJson({ error: "access_denied" }, 403);
  if (!runtime.staticClients.some((entry) => entry.clientId === client.clientId)) {
    const expiresAt = runtime.now() + CLIENT_TTL_MS;
    await runtime.store.put(`client:${client.clientId}`, JSON.stringify({ ...client, expiresAt }), expiresAt);
  }
  const stable: RefreshRow = { ...row, createdAt, expiresAt: createdAt + REFRESH_MAX_MS };
  return issueTokens(runtime, client.clientId, row.email, row.scope, { refresh, row: stable });
}

async function issueTokens(
  runtime: OAuthRuntime,
  clientId: string,
  email: string,
  scope: string,
  existing?: { refresh: string; row: RefreshRow },
): Promise<Response> {
  const access = randomUrlToken(32);
  const refresh = existing?.refresh ?? randomUrlToken(32);
  const refreshHash = sha256(refresh);
  const now = runtime.now();
  const refreshRow: RefreshRow = existing?.row ?? {
    clientId,
    email,
    scope,
    createdAt: now,
    expiresAt: now + REFRESH_MAX_MS,
  };
  const accessRow: AccessRow = {
    clientId,
    email,
    scope,
    resource: runtime.resource,
    refreshHash,
    expiresAt: now + ACCESS_TTL_MS,
  };
  await runtime.store.put(`access:${sha256(access)}`, JSON.stringify(accessRow), accessRow.expiresAt);
  if (!existing) await runtime.store.put(`refresh:${refreshHash}`, JSON.stringify(refreshRow), refreshRow.expiresAt);
  if (await runtime.store.get(`revoked:${refreshHash}`)) {
    await runtime.store.delete(`refresh:${refreshHash}`);
    await runtime.store.delete(`access:${sha256(access)}`);
    return oauthJson({ error: "invalid_grant" }, 400);
  }
  return oauthJson({
    access_token: access,
    token_type: "Bearer",
    expires_in: Math.floor(ACCESS_TTL_MS / 1000),
    refresh_token: refresh,
    scope,
  });
}

function pkceOk(verifier: string, challenge: string): boolean {
  if (verifier.length < 43 || verifier.length > 128 || !/^[A-Za-z0-9._~-]+$/.test(verifier)) return false;
  const actual = pkceS256(verifier);
  const left = Buffer.from(actual);
  const right = Buffer.from(challenge);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

async function findClient(runtime: OAuthRuntime, clientId: string): Promise<StoredClient | null> {
  if (!clientId) return null;
  const preset = runtime.staticClients.find((client) => client.clientId === clientId);
  if (preset) {
    return {
      clientId: preset.clientId,
      secretHash: sha256(preset.clientSecret),
      redirectUris: preset.redirectUris,
      authMethod: "client_secret_basic",
      expiresAt: runtime.now() + CLIENT_TTL_MS,
    };
  }
  const raw = await runtime.store.get(`client:${clientId}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredClient;
  } catch {
    return null;
  }
}

function clientAuthenticated(client: StoredClient, secret: string | undefined): boolean {
  if (client.authMethod === "none") return secret == null || secret === "";
  if (!secret || !client.secretHash) return false;
  return tokensEqual(client.secretHash, sha256(secret));
}

async function presentedClient(request: Request, form: URLSearchParams): Promise<{ clientId: string; secret?: string } | null> {
  const header = request.headers.get("authorization");
  if (header && /^Basic\s+/i.test(header)) {
    const decoded = decodeBasic(header.replace(/^Basic\s+/i, ""));
    if (!decoded) return null;
    return { clientId: decoded.id, ...(decoded.secret ? { secret: decoded.secret } : {}) };
  }
  const clientId = form.get("client_id");
  if (!clientId) return null;
  const secret = form.get("client_secret");
  return { clientId, ...(secret ? { secret } : {}) };
}

function decodeBasic(value: string): { id: string; secret: string } | null {
  try {
    const text = Buffer.from(value, "base64").toString("utf8");
    const index = text.indexOf(":");
    if (index <= 0) return null;
    return { id: decodeURIComponent(text.slice(0, index)), secret: decodeURIComponent(text.slice(index + 1)) };
  } catch {
    return null;
  }
}

async function takeJson<T extends { expiresAt: number }>(runtime: OAuthRuntime, key: string): Promise<T | null> {
  const raw = await runtime.store.take(key);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as T;
    if (value.expiresAt <= runtime.now()) return null;
    return value;
  } catch {
    return null;
  }
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length > 32_000) throw new Error("request body is too large");
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON object required");
  return value as Record<string, unknown>;
}

async function readForm(request: Request): Promise<URLSearchParams> {
  const text = await request.text();
  if (text.length > 32_000) throw new Error("request body is too large");
  const type = request.headers.get("content-type") ?? "";
  if (type.includes("application/json") && text) {
    const json = JSON.parse(text) as Record<string, unknown>;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(json)) {
      if (typeof value === "string") params.set(key, value);
    }
    return params;
  }
  return new URLSearchParams(text);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function randomUrlToken(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function oauthJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      pragma: "no-cache",
      "access-control-allow-origin": "*",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

function redirect(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      location,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

function htmlHeaders(): Record<string, string> {
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "content-security-policy": "frame-ancestors 'none'",
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
  };
}

function html(body: string, status: number): Response {
  const page = `<!doctype html><html><head><meta charset="utf-8"><title>grokcode</title></head><body><p>${body}</p></body></html>`;
  return htmlDocument(page, status);
}

function htmlDocument(page: string, status: number): Response {
  return new Response(page, { status, headers: htmlHeaders() });
}

function clientSummary(clientId: string, clientName: string, redirectUri: string): string {
  return `<p>Client <strong>${escapeHtml(clientName)}</strong> (<code>${escapeHtml(clientId)}</code>) will receive the authorization code at <code>${escapeHtml(redirectUri)}</code>.</p>`;
}

function approvalPage(txnId: string, clientId: string, clientName: string, redirectUri: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Approve grokcode</title></head>
<body>
<h1>Approve shell access</h1>
${clientSummary(clientId, clientName, redirectUri)}
<form method="post" action="/oauth/authorize">
<input type="hidden" name="txn" value="${escapeHtml(txnId)}">
<label>Owner approval secret <input type="password" name="secret" autocomplete="current-password" required></label>
<button type="submit">Approve</button>
</form>
</body></html>`;
}

function consentPage(consentId: string, csrf: string, clientId: string, clientName: string, redirectUri: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Approve grokcode</title></head>
<body>
<h1>Approve shell access</h1>
${clientSummary(clientId, clientName, redirectUri)}
<form method="post" action="/oauth/authorize">
<input type="hidden" name="consent" value="${escapeHtml(consentId)}">
<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<button type="submit">Approve</button>
</form>
</body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

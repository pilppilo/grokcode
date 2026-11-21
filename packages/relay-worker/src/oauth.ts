import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { MIN_TOKEN_LENGTH, tokensEqual } from "grokcode-shared";

/** MCP path Gemini and Antigravity call. OAuth tokens are only valid for this resource. */
export const GEMINI_MCP_PATH = "/gemini/mcp";

const ACCESS_TTL_MS = 60 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CODE_TTL_MS = 60 * 1000;
const TXN_TTL_MS = 10 * 60 * 1000;
const CLIENT_TTL_MS = 90 * 24 * 60 * 60 * 1000;

const GOOGLE_REDIRECT_HOSTS = new Set([
  "oauth-redirect.googleusercontent.com",
  "oauth-redirect-sandbox.googleusercontent.com",
  "oauth-redirect-test.googleusercontent.com",
]);

export interface OAuthStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, expiresAt?: number): Promise<void>;
  delete(key: string): Promise<void>;
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
  expiresAt: number;
}

interface AccessRow {
  clientId: string;
  email: string;
  scope: string;
  expiresAt: number;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

export function pkceS256(verifier: string): string {
  return sha256(verifier);
}

export function redirectUriAllowed(uri: string): boolean {
  if (uri.includes("#") || uri.includes("\\") || /\s/.test(uri)) return false;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.username || url.password || url.hash) return false;
  if (url.protocol === "https:" && GOOGLE_REDIRECT_HOSTS.has(url.hostname)) return true;
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
      redirectUris.some((item) => typeof item !== "string" || !redirectUriAllowed(item))
    ) {
      throw new Error(`OAUTH_CLIENTS redirect URIs for "${clientId}" are missing or not on the allowlist.`);
    }
    return { clientId, clientSecret, redirectUris: redirectUris as string[] };
  });
}

export function emailAllowed(email: string, ownerEmails: readonly string[]): boolean {
  if (email === "owner") return true;
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
  const approval = config.approvalSecret && config.approvalSecret.length >= MIN_TOKEN_LENGTH ? config.approvalSecret : undefined;
  return {
    issuer: origin,
    resource: `${origin}${GEMINI_MCP_PATH}`,
    store: config.store,
    ownerEmails: (config.ownerEmails ?? []).map((item) => item.toLowerCase()),
    ...(approval ? { approvalSecret: approval } : {}),
    staticClients: config.staticClients ?? [],
    ...(identity ? { identity } : {}),
    now: config.now ?? Date.now,
  };
}

export async function handleOAuthRequest(request: Request, config: OAuthConfig): Promise<Response> {
  const runtime = runtimeFromRequest(request, config);
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
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
  if (!emailAllowed(row.email, runtime.ownerEmails)) return null;
  return { email: row.email, clientId: row.clientId };
}

function metadata(runtime: OAuthRuntime): Response {
  return oauthJson({
    issuer: runtime.issuer,
    authorization_endpoint: `${runtime.issuer}/oauth/authorize`,
    token_endpoint: `${runtime.issuer}/oauth/token`,
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
  if (redirects.length === 0 || redirects.length > 8 || redirects.some((uri) => !redirectUriAllowed(uri))) {
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
  await runtime.store.put(`client:${clientId}`, JSON.stringify(stored), expiresAt);
  return oauthJson(
    {
      client_id: clientId,
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
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
  if (!client.redirectUris.includes(redirectUri)) return oauthJson({ error: "invalid_request", error_description: "redirect_uri is not registered." }, 400);
  if (params.get("code_challenge_method") !== "S256") {
    return oauthJson({ error: "invalid_request", error_description: "PKCE S256 is required." }, 400);
  }
  const challenge = params.get("code_challenge") ?? "";
  if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) return oauthJson({ error: "invalid_request", error_description: "code_challenge is invalid." }, 400);
  const state = params.get("state") ?? "";
  if (state.length === 0 || state.length > 512 || /[\r\n]/.test(state)) {
    return oauthJson({ error: "invalid_request", error_description: "state is required." }, 400);
  }
  const scope = params.get("scope") ?? "shell";
  if (scope.split(/\s+/).some((item) => item !== "shell" && item !== "offline_access")) {
    return oauthJson({ error: "invalid_scope" }, 400);
  }
  const resource = params.get("resource");
  if (resource && resource !== runtime.resource && resource !== `${runtime.resource}/`) {
    return oauthJson({ error: "invalid_target", error_description: "resource does not match this server." }, 400);
  }
  if (!runtime.identity && !runtime.approvalSecret) {
    return html("Owner sign-in is not configured. Set OWNER_EMAILS plus Google credentials, or OWNER_APPROVAL_SECRET.", 503);
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
  return new Response(approvalPage(txnId, client.clientName ?? client.clientId, redirectUri), {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
}

async function approve(request: Request, runtime: OAuthRuntime): Promise<Response> {
  if (!runtime.approvalSecret) return html("Owner approval is not configured.", 503);
  const form = await readForm(request);
  const txnId = form.get("txn") ?? "";
  const secret = form.get("secret") ?? "";
  const raw = await runtime.store.get(`txn:${txnId}`);
  if (!raw) return html("This approval request expired. Start the connection again.", 400);
  let txn: Txn;
  try {
    txn = JSON.parse(raw) as Txn;
  } catch {
    return html("This approval request expired. Start the connection again.", 400);
  }
  if (txn.expiresAt <= runtime.now()) {
    await runtime.store.delete(`txn:${txnId}`);
    return html("This approval request expired. Start the connection again.", 400);
  }
  if (!tokensEqual(runtime.approvalSecret, secret)) return html("Approval rejected.", 403);
  await runtime.store.delete(`txn:${txnId}`);
  return finish(runtime, txn, "owner");
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
  return finish(runtime, txn, profile.email.toLowerCase());
}

async function finish(runtime: OAuthRuntime, txn: Txn, email: string): Promise<Response> {
  if (!emailAllowed(email, runtime.ownerEmails)) return html("This account cannot use this relay.", 403);
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

async function exchangeCode(runtime: OAuthRuntime, client: StoredClient, form: URLSearchParams): Promise<Response> {
  const code = form.get("code") ?? "";
  const redirectUri = form.get("redirect_uri") ?? "";
  const verifier = form.get("code_verifier") ?? "";
  const row = await takeJson<AuthCode>(runtime, `code:${sha256(code)}`);
  if (!row || row.clientId !== client.clientId || row.redirectUri !== redirectUri) {
    return oauthJson({ error: "invalid_grant" }, 400);
  }
  if (!pkceOk(verifier, row.codeChallenge)) return oauthJson({ error: "invalid_grant", error_description: "PKCE verification failed." }, 400);
  if (!emailAllowed(row.email, runtime.ownerEmails)) return oauthJson({ error: "access_denied" }, 403);
  return issueTokens(runtime, client.clientId, row.email, row.scope);
}

async function exchangeRefresh(runtime: OAuthRuntime, client: StoredClient, form: URLSearchParams): Promise<Response> {
  const refresh = form.get("refresh_token") ?? "";
  const row = await takeJson<RefreshRow>(runtime, `refresh:${sha256(refresh)}`);
  if (!row || row.clientId !== client.clientId) return oauthJson({ error: "invalid_grant" }, 400);
  if (!emailAllowed(row.email, runtime.ownerEmails)) return oauthJson({ error: "access_denied" }, 403);
  return issueTokens(runtime, client.clientId, row.email, row.scope);
}

async function issueTokens(runtime: OAuthRuntime, clientId: string, email: string, scope: string): Promise<Response> {
  const access = randomUrlToken(32);
  const refresh = randomUrlToken(32);
  const accessRow: AccessRow = { clientId, email, scope, expiresAt: runtime.now() + ACCESS_TTL_MS };
  const refreshRow: RefreshRow = { clientId, email, scope, expiresAt: runtime.now() + REFRESH_TTL_MS };
  await runtime.store.put(`access:${sha256(access)}`, JSON.stringify(accessRow), accessRow.expiresAt);
  await runtime.store.put(`refresh:${sha256(refresh)}`, JSON.stringify(refreshRow), refreshRow.expiresAt);
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
  const raw = await runtime.store.get(key);
  if (!raw) return null;
  await runtime.store.delete(key);
  try {
    const value = JSON.parse(raw) as T;
    if (value.expiresAt <= runtime.now()) return null;
    return value;
  } catch {
    return null;
  }
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

function html(body: string, status: number): Response {
  const page = `<!doctype html><html><head><meta charset="utf-8"><title>grokcode</title></head><body><p>${body}</p></body></html>`;
  return new Response(page, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
}

function approvalPage(txnId: string, clientName: string, redirectUri: string): string {
  let host = redirectUri;
  try {
    host = new URL(redirectUri).host;
  } catch {
    host = "the client";
  }
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Approve grokcode</title></head>
<body>
<h1>Approve shell access</h1>
<p>Client <strong>${escapeHtml(clientName)}</strong> wants to run commands on your machines. Redirect host: ${escapeHtml(host)}.</p>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="txn" value="${escapeHtml(txnId)}">
<label>Owner approval secret <input type="password" name="secret" autocomplete="current-password" required></label>
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

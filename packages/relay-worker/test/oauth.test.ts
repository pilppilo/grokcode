import assert from "node:assert/strict";
import test from "node:test";

import {
  MemoryOAuthStore,
  accessTokenSubject,
  handleOAuthRequest,
  pkceS256,
  redirectUriAllowed,
  sha256,
  type IdentityProvider,
  type OAuthConfig,
} from "../src/oauth.ts";

const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const REDIRECT = "http://127.0.0.1/callback";
const SECRET = "owner-approval-secret-1";

function setup(extra: Partial<OAuthConfig> = {}) {
  let now = 1_700_000_000_000;
  const store = new MemoryOAuthStore(() => now);
  const config: OAuthConfig = {
    store,
    pinnedRedirects: [REDIRECT, "https://oauth-redirect.googleusercontent.com/r/gemini"],
    ownerEmails: ["ada@example.com"],
    approvalSecret: SECRET,
    now: () => now,
    publicOrigin: "https://relay.example",
    ...extra,
  };
  return {
    config,
    store,
    advance(ms: number) {
      now += ms;
    },
  };
}

async function register(config: OAuthConfig, redirect = REDIRECT) {
  const response = await handleOAuthRequest(
    new Request("https://relay.example/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [redirect],
        client_name: "Gemini",
        token_endpoint_auth_method: "none",
      }),
    }),
    config,
  );
  assert.equal(response.status, 201);
  return (await response.json()) as { client_id: string };
}

test("PKCE S256 matches the RFC 7636 vector", () => {
  assert.equal(pkceS256(VERIFIER), CHALLENGE);
});

test("owner approval caps concurrent guesses and unlocks after an hour", async () => {
  const { config, advance } = setup();
  const client = await register(config);
  const begin = async () => {
    const url = new URL("https://relay.example/oauth/authorize");
    url.search = new URLSearchParams({
      response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT,
      state: "test", code_challenge: CHALLENGE, code_challenge_method: "S256",
    }).toString();
    const response = await handleOAuthRequest(new Request(url), config);
    const txn = /name="txn" value="([^"]+)"/.exec(await response.text())?.[1];
    assert.ok(txn);
    return txn;
  };
  const approve = (txn: string, secret: string) => handleOAuthRequest(
    new Request("https://relay.example/oauth/authorize", { method: "POST", body: new URLSearchParams({ txn, secret }) }),
    config,
  );
  const approved = await begin();
  const first = await Promise.all([approve(approved, SECRET), approve(approved, SECRET)]);
  assert.deepEqual(first.map((response) => response.status).sort(), [302, 400]);
  assert.ok(new URL(first.find((response) => response.status === 302)!.headers.get("location")!).searchParams.get("code"));

  const expired = await begin();
  const guesses = await Promise.all(Array.from({ length: 4 }, () => approve(expired, "wrong")));
  assert.deepEqual(guesses.map((response) => response.status).sort(), [400, 403, 403, 403]);
  assert.equal((await approve(expired, SECRET)).status, 400);

  for (let i = 0; i < 7; i++) assert.equal((await approve(await begin(), "wrong")).status, 403);
  assert.equal((await approve(await begin(), SECRET)).status, 429);
  advance(60 * 60 * 1000);
  assert.equal((await approve(await begin(), SECRET)).status, 302);
});

test("metadata, dynamic registration, approval, and token checks", async () => {
  const { config, advance } = setup();
  const metadata = await handleOAuthRequest(new Request("https://relay.example/.well-known/oauth-authorization-server"), config);
  const meta = (await metadata.json()) as Record<string, unknown>;
  assert.equal(meta.authorization_endpoint, "https://relay.example/oauth/authorize");
  assert.equal(meta.token_endpoint, "https://relay.example/oauth/token");
  assert.equal(meta.registration_endpoint, "https://relay.example/oauth/register");
  assert.deepEqual(meta.response_types_supported, ["code"]);
  assert.ok((meta.code_challenge_methods_supported as string[]).includes("S256"));

  const resource = await handleOAuthRequest(
    new Request("https://relay.example/.well-known/oauth-protected-resource/gemini/mcp"),
    config,
  );
  const resourceBody = (await resource.json()) as { resource: string; authorization_servers: string[] };
  assert.equal(resourceBody.resource, "https://relay.example/gemini/mcp");
  assert.deepEqual(resourceBody.authorization_servers, ["https://relay.example"]);

  const evil = await handleOAuthRequest(
    new Request("https://relay.example/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://evil.example/steal"] }),
    }),
    config,
  );
  assert.equal(evil.status, 400);

  const client = await register(config);
  const missingPkce = await handleOAuthRequest(
    new Request(
      `https://relay.example/oauth/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&state=xyz`,
    ),
    config,
  );
  assert.equal(missingPkce.status, 400);

  const page = await handleOAuthRequest(
    new Request(
      `https://relay.example/oauth/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&state=xyz&code_challenge=${CHALLENGE}&code_challenge_method=S256`,
    ),
    config,
  );
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  assert.match(page.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  const html = await page.text();
  const txn = /name="txn" value="([^"]+)"/.exec(html)?.[1];
  assert.ok(txn);

  const rejected = await handleOAuthRequest(
    new Request("https://relay.example/oauth/authorize", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ txn: txn!, secret: "not-the-owner-secret" }),
    }),
    config,
  );
  assert.equal(rejected.status, 403);

  const approved = await handleOAuthRequest(
    new Request("https://relay.example/oauth/authorize", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ txn: txn!, secret: SECRET }),
    }),
    config,
  );
  assert.equal(approved.status, 302);
  const location = new URL(approved.headers.get("location") ?? "");
  assert.equal(location.searchParams.get("state"), "xyz");
  const code = location.searchParams.get("code");
  assert.ok(code);

  const badVerifier = await handleOAuthRequest(
    new Request("https://relay.example/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code!,
        redirect_uri: REDIRECT,
        client_id: client.client_id,
        code_verifier: "a".repeat(50),
      }),
    }),
    config,
  );
  assert.equal(badVerifier.status, 400);

  const page2 = await handleOAuthRequest(
    new Request(
      `https://relay.example/oauth/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&state=xyz&code_challenge=${CHALLENGE}&code_challenge_method=S256`,
    ),
    config,
  );
  const txn2 = /name="txn" value="([^"]+)"/.exec(await page2.text())?.[1];
  const approved2 = await handleOAuthRequest(
    new Request("https://relay.example/oauth/authorize", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ txn: txn2!, secret: SECRET }),
    }),
    config,
  );
  const code2 = new URL(approved2.headers.get("location") ?? "").searchParams.get("code");
  const traded = await handleOAuthRequest(
    new Request("https://relay.example/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code2!,
        redirect_uri: REDIRECT,
        client_id: client.client_id,
        code_verifier: VERIFIER,
      }),
    }),
    config,
  );
  assert.equal(traded.status, 200);
  const tokens = (await traded.json()) as { access_token: string; refresh_token: string; token_type: string };
  assert.equal(tokens.token_type, "Bearer");
  const subject = await accessTokenSubject(tokens.access_token, config, new Request("https://relay.example/gemini/mcp"));
  assert.equal(subject?.email, "ada@example.com");
  assert.equal(await accessTokenSubject("not-a-real-token-value-at-all", config, new Request("https://relay.example/gemini/mcp")), null);

  const reused = await handleOAuthRequest(
    new Request("https://relay.example/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code2!,
        redirect_uri: REDIRECT,
        client_id: client.client_id,
        code_verifier: VERIFIER,
      }),
    }),
    config,
  );
  assert.equal(reused.status, 400);

  advance(2 * 60 * 60 * 1000);
  assert.equal(await accessTokenSubject(tokens.access_token, config, new Request("https://relay.example/gemini/mcp")), null);
  const refreshed = await handleOAuthRequest(
    new Request("https://relay.example/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: client.client_id,
      }),
    }),
    config,
  );
  assert.equal(refreshed.status, 200);
  const next = (await refreshed.json()) as { access_token: string; refresh_token: string };
  assert.equal(next.refresh_token, tokens.refresh_token);
  assert.notEqual(next.access_token, tokens.access_token);
  assert.ok(await accessTokenSubject(next.access_token, config, new Request("https://relay.example/gemini/mcp")));

  const revoked = await handleOAuthRequest(
    new Request("https://relay.example/oauth/revoke", {
      method: "POST",
      body: new URLSearchParams({ token: next.access_token, client_id: client.client_id }),
    }),
    config,
  );
  assert.equal(revoked.status, 200);
  assert.equal(await accessTokenSubject(next.access_token, config, new Request("https://relay.example/gemini/mcp")), null);
  const afterRevocation = await handleOAuthRequest(
    new Request("https://relay.example/oauth/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: client.client_id,
      }),
    }),
    config,
  );
  assert.equal(afterRevocation.status, 400);
  assert.deepEqual(await afterRevocation.json(), { error: "invalid_grant" });
});

test("google sign-in rejects a verified account that is not the owner", async () => {
  const identity: IdentityProvider = {
    authorizationUrl({ state }) {
      return `https://accounts.google.test/auth?state=${state}`;
    },
    async exchange() {
      return { email: "other@evil.test", sub: "attacker", emailVerified: true };
    },
  };
  const { config } = setup({ identity, approvalSecret: undefined });
  const client = await register(config, "https://oauth-redirect.googleusercontent.com/r/gemini");
  const start = await handleOAuthRequest(
    new Request(
      `https://relay.example/oauth/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent("https://oauth-redirect.googleusercontent.com/r/gemini")}&state=from-gemini&code_challenge=${CHALLENGE}&code_challenge_method=S256`,
    ),
    config,
  );
  assert.equal(start.status, 302);
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
  const callback = await handleOAuthRequest(
    new Request(`https://relay.example/oauth/google/callback?code=fake&state=${state}`),
    config,
  );
  assert.equal(callback.status, 403);
  const body = await callback.text();
  assert.match(body, /other@evil.test/);
  assert.equal(body.includes("code="), false);
});

test("google sign-in issues a code only for the allowlisted owner", async () => {
  const identity: IdentityProvider = {
    authorizationUrl({ state }) {
      return `https://accounts.google.test/auth?state=${state}`;
    },
    async exchange() {
      return { email: "Ada@Example.com", sub: "ada", emailVerified: true };
    },
  };
  const { config } = setup({ identity, approvalSecret: undefined });
  const redirect = "https://oauth-redirect.googleusercontent.com/r/gemini";
  const client = await register(config, redirect);
  const start = await handleOAuthRequest(
    new Request(
      `https://relay.example/oauth/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent(redirect)}&state=from-gemini&code_challenge=${CHALLENGE}&code_challenge_method=S256`,
    ),
    config,
  );
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
  const callback = await handleOAuthRequest(
    new Request(`https://relay.example/oauth/google/callback?code=fake&state=${state}`),
    config,
  );
  assert.equal(callback.status, 200);
  assert.equal(callback.headers.get("x-frame-options"), "DENY");
  assert.match(callback.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  const consentHtml = await callback.text();
  assert.match(consentHtml, /Gemini/);
  assert.match(consentHtml, new RegExp(client.client_id));
  assert.match(consentHtml, /https:\/\/oauth-redirect\.googleusercontent\.com\/r\/gemini/);
  const consent = /name="consent" value="([^"]+)"/.exec(consentHtml)?.[1];
  const csrf = /name="csrf" value="([^"]+)"/.exec(consentHtml)?.[1];
  assert.ok(consent && csrf);
  const approved = await handleOAuthRequest(
    new Request("https://relay.example/oauth/authorize", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ consent: consent!, csrf: csrf! }),
    }),
    config,
  );
  assert.equal(approved.status, 302);
  const code = new URL(approved.headers.get("location") ?? "").searchParams.get("code");
  assert.ok(code);
  const traded = await handleOAuthRequest(
    new Request("https://relay.example/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code!,
        redirect_uri: redirect,
        client_id: client.client_id,
        code_verifier: VERIFIER,
      }),
    }),
    config,
  );
  const tokens = (await traded.json()) as { access_token: string };
  const subject = await accessTokenSubject(tokens.access_token, config, new Request("https://relay.example/gemini/mcp"));
  assert.equal(subject?.email, "ada@example.com");
});

test("google redirect paths are limited to /r/ and /a/ until an exact URI is pinned", () => {
  assert.equal(redirectUriAllowed("https://oauth-redirect.googleusercontent.com/r/app"), true);
  assert.equal(redirectUriAllowed("https://oauth-redirect.googleusercontent.com/a/app"), true);
  assert.equal(redirectUriAllowed("https://oauth-redirect.googleusercontent.com/steal"), false);
  assert.equal(redirectUriAllowed("https://oauth-redirect.googleusercontent.com/r/../x"), false);
  assert.equal(
    redirectUriAllowed("https://oauth-redirect.googleusercontent.com/r/other", [
      "https://oauth-redirect.googleusercontent.com/r/known",
    ]),
    false,
  );
  assert.equal(
    redirectUriAllowed("https://oauth-redirect.googleusercontent.com/r/known", [
      "https://oauth-redirect.googleusercontent.com/r/known",
    ]),
    true,
  );
});

test("google sign-in shows consent before the code is issued and a bad csrf cannot finish", async () => {
  const identity: IdentityProvider = {
    authorizationUrl({ state }) {
      return `https://accounts.google.test/auth?state=${state}`;
    },
    async exchange() {
      return { email: "ada@example.com", sub: "ada", emailVerified: true };
    },
  };
  const { config } = setup({ identity, approvalSecret: "owner-approval-secret-1" });
  const redirect = "https://oauth-redirect.googleusercontent.com/r/gemini";
  const client = await register(config, redirect);
  const start = await handleOAuthRequest(
    new Request(
      `https://relay.example/oauth/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent(redirect)}&state=from-gemini&code_challenge=${CHALLENGE}&code_challenge_method=S256`,
    ),
    config,
  );
  assert.equal(start.status, 302);
  const bypass = await handleOAuthRequest(
    new Request("https://relay.example/oauth/authorize", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ txn: "nope", secret: "owner-approval-secret-1" }),
    }),
    config,
  );
  assert.equal(bypass.status, 503);
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
  const callback = await handleOAuthRequest(new Request(`https://relay.example/oauth/google/callback?code=fake&state=${state}`), config);
  const html = await callback.text();
  const consent = /name="consent" value="([^"]+)"/.exec(html)?.[1];
  const rejected = await handleOAuthRequest(
    new Request("https://relay.example/oauth/authorize", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ consent: consent!, csrf: "not-the-token" }),
    }),
    config,
  );
  assert.equal(rejected.status, 400);
  assert.equal(rejected.headers.get("location"), null);
});

test("an authorization code can be redeemed only once, even in parallel", async () => {
  const { config } = setup();
  const client = await register(config);
  const page = await handleOAuthRequest(
    new Request(
      `https://relay.example/oauth/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&state=xyz&code_challenge=${CHALLENGE}&code_challenge_method=S256`,
    ),
    config,
  );
  const txn = /name="txn" value="([^"]+)"/.exec(await page.text())?.[1];
  const approved = await handleOAuthRequest(
    new Request("https://relay.example/oauth/authorize", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ txn: txn!, secret: SECRET }),
    }),
    config,
  );
  const code = new URL(approved.headers.get("location") ?? "").searchParams.get("code");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: code!,
    redirect_uri: REDIRECT,
    client_id: client.client_id,
    code_verifier: VERIFIER,
  });
  const [first, second] = await Promise.all([
    handleOAuthRequest(new Request("https://relay.example/oauth/token", { method: "POST", body }), config),
    handleOAuthRequest(new Request("https://relay.example/oauth/token", { method: "POST", body: new URLSearchParams(body) }), config),
  ]);
  const statuses = [first.status, second.status].sort();
  assert.deepEqual(statuses, [200, 400]);
});

test("refresh tokens stay the same and die at an absolute 90 day lifetime", async () => {
  const { config, advance } = setup();
  const client = await register(config);
  const page = await handleOAuthRequest(
    new Request(
      `https://relay.example/oauth/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&state=xyz&code_challenge=${CHALLENGE}&code_challenge_method=S256`,
    ),
    config,
  );
  const txn = /name="txn" value="([^"]+)"/.exec(await page.text())?.[1];
  const approved = await handleOAuthRequest(
    new Request("https://relay.example/oauth/authorize", {
      method: "POST",
      body: new URLSearchParams({ txn: txn!, secret: SECRET }),
    }),
    config,
  );
  const code = new URL(approved.headers.get("location") ?? "").searchParams.get("code");
  const traded = await handleOAuthRequest(
    new Request("https://relay.example/oauth/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code!,
        redirect_uri: REDIRECT,
        client_id: client.client_id,
        code_verifier: VERIFIER,
      }),
    }),
    config,
  );
  const tokens = (await traded.json()) as { refresh_token: string };
  const day = 24 * 60 * 60 * 1000;
  advance(80 * day);
  const refreshed = await handleOAuthRequest(
    new Request("https://relay.example/oauth/token", {
      method: "POST",
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id }),
    }),
    config,
  );
  assert.equal(refreshed.status, 200);
  const next = (await refreshed.json()) as { refresh_token: string };
  assert.equal(next.refresh_token, tokens.refresh_token);
  advance(20 * day);
  const expired = await handleOAuthRequest(
    new Request("https://relay.example/oauth/token", {
      method: "POST",
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id }),
    }),
    config,
  );
  assert.equal(expired.status, 400);
});

test("the owner subject does not bypass OWNER_EMAILS and the resource is bound to the token", async () => {
  const { config, store } = setup();
  const token = "owner-token-value-0123456789";
  const resource = "https://relay.example/gemini/mcp";
  await store.put(
    `access:${sha256(token)}`,
    JSON.stringify({ clientId: "c", email: "owner", scope: "shell", resource, expiresAt: 2_000_000_000_000 }),
  );
  assert.equal(await accessTokenSubject(token, config, new Request(`${resource}`)), null);
  const other = "resource-token-value-0123456789";
  await store.put(
    `access:${sha256(other)}`,
    JSON.stringify({
      clientId: "c",
      email: "ada@example.com",
      scope: "shell",
      resource: "https://other.example/gemini/mcp",
      expiresAt: 2_000_000_000_000,
    }),
  );
  assert.equal(await accessTokenSubject(other, config, new Request(resource)), null);
});

test("empty scope is accepted, registration reports the client TTL, and OPTIONS carries CORS", async () => {
  const { config } = setup();
  const options = await handleOAuthRequest(new Request("https://relay.example/oauth/register", { method: "OPTIONS" }), config);
  assert.equal(options.status, 204);
  assert.equal(options.headers.get("access-control-allow-origin"), "*");
  const registered = await handleOAuthRequest(
    new Request("https://relay.example/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: "client_secret_post",
        scope: "",
      }),
    }),
    config,
  );
  assert.equal(registered.status, 201);
  const body = (await registered.json()) as { client_secret_expires_at: number; client_id: string };
  const issuedAt = 1_700_000_000;
  assert.equal(body.client_secret_expires_at, issuedAt + 90 * 24 * 60 * 60);
  const page = await handleOAuthRequest(
    new Request(
      `https://relay.example/oauth/authorize?response_type=code&client_id=${body.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&state=xyz&code_challenge=${CHALLENGE}&code_challenge_method=S256&scope=`,
    ),
    config,
  );
  assert.equal(page.status, 200);
});

test("dynamic registration caps concurrent requests and frees expired slots", async () => {
  const { config, store, advance } = setup({ registrationQuota: 1 });
  await store.put("dcr:count", "50");
  const attempt = () => handleOAuthRequest(
    new Request("https://relay.example/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }),
    }),
    config,
  );
  const responses = await Promise.all([attempt(), attempt(), attempt()]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [201, 429, 429]);
  advance(90 * 24 * 60 * 60 * 1000);
  assert.equal((await attempt()).status, 201);
});

test("loopback registration and existing loopback clients require configured redirect pins", async () => {
  const { config } = setup();
  const client = await register(config);
  delete config.pinnedRedirects;
  const registerResponse = await handleOAuthRequest(new Request("https://relay.example/oauth/register", {
    method: "POST",
    body: JSON.stringify({ redirect_uris: [REDIRECT] }),
  }), config);
  assert.equal(registerResponse.status, 400);
  const url = new URL("https://relay.example/oauth/authorize");
  url.search = new URLSearchParams({ client_id: client.client_id, redirect_uri: REDIRECT, response_type: "code" }).toString();
  const response = await handleOAuthRequest(new Request(url), config);
  assert.equal((await response.json() as { error_description: string }).error_description, "redirect_uri is not registered.");
});

const GEMINI_CALLBACKS = [
  "oauth-redirect.googleusercontent.com",
  "oauth-redirect-sandbox.googleusercontent.com",
  "oauth-redirect-test.googleusercontent.com",
].flatMap((host) => ["r", "a"].map((prefix) => `https://${host}/${prefix}/user_bound_custom-mcp-test`));

test("unpinned Gemini clients can register the six official Connected Apps callbacks", async () => {
  const { config } = setup({ pinnedRedirects: [] });
  for (const uri of GEMINI_CALLBACKS) {
    assert.equal(redirectUriAllowed(uri, []), true);
    await register(config, uri);
  }
  for (const uri of [
    "https://oauth-redirect.googleusercontent.com/other/user_bound_custom-mcp-test",
    "https://oauth-redirect.googleusercontent.com:444/r/user_bound_custom-mcp-test",
    "http://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-test",
    "https://evil.googleusercontent.com/r/user_bound_custom-mcp-test",
    "https://localhost/r/user_bound_custom-mcp-test",
  ]) {
    assert.equal(redirectUriAllowed(uri, []), false);
    const rejected = await handleOAuthRequest(
      new Request("https://relay.example/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: [uri], token_endpoint_auth_method: "none" }),
      }),
      config,
    );
    assert.equal(rejected.status, 400);
  }
});

test("one dynamic registration accepts Gemini's six callbacks and echoes them", async () => {
  const { config } = setup({ pinnedRedirects: [] });
  const response = await handleOAuthRequest(
    new Request("https://relay.example/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: GEMINI_CALLBACKS,
        client_name: "Gemini",
        token_endpoint_auth_method: "client_secret_post",
      }),
    }),
    config,
  );
  assert.equal(response.status, 201);
  const body = (await response.json()) as { redirect_uris: string[]; token_endpoint_auth_method: string };
  assert.deepEqual(body.redirect_uris, GEMINI_CALLBACKS);
  assert.equal(body.token_endpoint_auth_method, "client_secret_post");
});

test("authorize accepts a long Gemini state and finish returns it unchanged", async () => {
  const { config } = setup();
  const client = await register(config);
  const state = `gemini.${"A".repeat(1182)}.state-tail`;
  assert.equal(state.length, 1200);
  const page = await handleOAuthRequest(
    new Request(
      `https://relay.example/oauth/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&state=${encodeURIComponent(state)}&code_challenge=${CHALLENGE}&code_challenge_method=S256`,
    ),
    config,
  );
  assert.equal(page.status, 200);
  const txn = /name="txn" value="([^"]+)"/.exec(await page.text())?.[1];
  const approved = await handleOAuthRequest(
    new Request("https://relay.example/oauth/authorize", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ txn: txn!, secret: SECRET }),
    }),
    config,
  );
  assert.equal(approved.status, 302);
  assert.equal(new URL(approved.headers.get("location") ?? "").searchParams.get("state"), state);

  const tooLong = await handleOAuthRequest(
    new Request(
      `https://relay.example/oauth/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&state=${encodeURIComponent("s".repeat(8193))}&code_challenge=${CHALLENGE}&code_challenge_method=S256`,
    ),
    config,
  );
  assert.equal(tooLong.status, 400);
  assert.equal((await tooLong.json() as { error_description: string }).error_description, "state is invalid.");

  const broken = await handleOAuthRequest(
    new Request(
      `https://relay.example/oauth/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&state=${encodeURIComponent("line\nbreak")}&code_challenge=${CHALLENGE}&code_challenge_method=S256`,
    ),
    config,
  );
  assert.equal(broken.status, 400);
  assert.equal((await broken.json() as { error_description: string }).error_description, "state is invalid.");

  const missing = await handleOAuthRequest(
    new Request(
      `https://relay.example/oauth/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${CHALLENGE}&code_challenge_method=S256`,
    ),
    config,
  );
  assert.equal(missing.status, 400);
  assert.equal((await missing.json() as { error_description: string }).error_description, "state is required.");
});

test("approval-secret mode requires OWNER_EMAILS before the secret form", async () => {
  const { config, store } = setup({ ownerEmails: [] });
  const client = await register(config);
  const page = await handleOAuthRequest(
    new Request(
      `https://relay.example/oauth/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&state=xyz&code_challenge=${CHALLENGE}&code_challenge_method=S256`,
    ),
    config,
  );
  assert.equal(page.status, 503);
  const body = await page.text();
  assert.match(body, /OWNER_EMAILS/);
  assert.match(body, /OWNER_APPROVAL_SECRET/);
  assert.match(body, /at least 16 characters/);

  await store.put(
    "txn:saved",
    JSON.stringify({
      clientId: client.client_id,
      redirectUri: REDIRECT,
      codeChallenge: CHALLENGE,
      clientState: "xyz",
      scope: "shell",
      expiresAt: 2_000_000_000_000,
    }),
    2_000_000_000_000,
  );
  const approved = await handleOAuthRequest(
    new Request("https://relay.example/oauth/authorize", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ txn: "saved", secret: SECRET }),
    }),
    config,
  );
  assert.equal(approved.status, 503);
  assert.match(await approved.text(), /Set OWNER_EMAILS to use the approval secret/);
});

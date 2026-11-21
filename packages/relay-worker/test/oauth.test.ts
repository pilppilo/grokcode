import assert from "node:assert/strict";
import test from "node:test";

import {
  MemoryOAuthStore,
  accessTokenSubject,
  handleOAuthRequest,
  pkceS256,
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
  assert.equal(subject?.email, "owner");
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
  assert.equal(callback.status, 302);
  const code = new URL(callback.headers.get("location") ?? "").searchParams.get("code");
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

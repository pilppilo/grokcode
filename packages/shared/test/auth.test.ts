import assert from "node:assert/strict";
import test from "node:test";

import {
  bearerToken,
  clientAuthorized,
  machineAuthorized,
  parseMachineTokens,
  tokensEqual,
} from "../src/auth.ts";

const TOKEN_A = "laptop-token-0123456789abcdef";
const TOKEN_B = "desktop-token-0123456789abc";

test("tokensEqual ignores length leaks and rejects mismatches", () => {
  assert.equal(tokensEqual(TOKEN_A, TOKEN_A), true);
  assert.equal(tokensEqual(TOKEN_A, TOKEN_B), false);
  assert.equal(tokensEqual(TOKEN_A, TOKEN_A + "x"), false);
  assert.equal(tokensEqual("", ""), true);
});

test("bearerToken parses a single Authorization scheme", () => {
  assert.equal(bearerToken("Bearer " + TOKEN_A), TOKEN_A);
  assert.equal(bearerToken("bearer " + TOKEN_A), TOKEN_A);
  assert.equal(bearerToken("Basic abc"), null);
  assert.equal(bearerToken("Bearer one two"), null);
  assert.equal(bearerToken(null), null);
});

test("parseMachineTokens accepts a name map and hides the raw secret on failure", () => {
  const parsed = parseMachineTokens(JSON.stringify({ laptop: TOKEN_A, desktop: TOKEN_B }));
  assert.deepEqual(Object.keys(parsed).sort(), ["desktop", "laptop"]);
  assert.throws(() => parseMachineTokens("{not json"), /not valid JSON/);
  assert.throws(() => parseMachineTokens(JSON.stringify({ "bad name": TOKEN_A })), /invalid machine name/);
  assert.throws(() => parseMachineTokens(JSON.stringify({ laptop: "short" })), /at least 16/);
});

test("machine and client authorization are per-secret", () => {
  const tokens = { laptop: TOKEN_A };
  assert.equal(machineAuthorized(tokens, "laptop", TOKEN_A), true);
  assert.equal(machineAuthorized(tokens, "desktop", TOKEN_A), false);
  assert.equal(machineAuthorized(tokens, "laptop", TOKEN_B), false);
  assert.equal(machineAuthorized(tokens, "laptop", null), false);
  assert.equal(clientAuthorized(TOKEN_A, TOKEN_A), true);
  assert.equal(clientAuthorized("short-token", "short-token"), false);
  assert.equal(clientAuthorized(undefined, TOKEN_A), false);
});

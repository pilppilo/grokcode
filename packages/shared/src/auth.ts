import { createHash, timingSafeEqual } from "node:crypto";

import { ToolError } from "./errors.js";

/** Machine names are used as routing keys and WebSocket tags. */
export const MACHINE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;

export const MIN_TOKEN_LENGTH = 16;

export function assertMachineName(name: string): string {
  if (!MACHINE_NAME.test(name)) {
    throw new ToolError(
      "Machine name must be 1-64 characters and contain only letters, digits, '.', '_' or '-'.",
      "invalid_machine_name",
    );
  }
  return name;
}

/**
 * Compare two secrets without leaking which one mismatched, including length.
 * Both sides are hashed to a fixed width before the constant-time compare.
 */
export function tokensEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

export function bearerToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1] ?? null;
}

export type MachineTokenMap = Record<string, string>;

/**
 * Parse the MACHINE_TOKENS secret. Accepts a JSON object of name → token.
 * Throws a message that does not echo the secret.
 */
export function parseMachineTokens(raw: string | undefined | null): MachineTokenMap {
  if (raw == null || raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("MACHINE_TOKENS is not valid JSON. Expected an object of machine name to token.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("MACHINE_TOKENS must be a JSON object of machine name to token.");
  }
  const out: MachineTokenMap = {};
  for (const [name, token] of Object.entries(parsed)) {
    if (!MACHINE_NAME.test(name)) {
      throw new Error(`MACHINE_TOKENS has an invalid machine name "${name}".`);
    }
    if (typeof token !== "string" || token.length < MIN_TOKEN_LENGTH) {
      throw new Error(
        `MACHINE_TOKENS entry "${name}" must be a string of at least ${MIN_TOKEN_LENGTH} characters.`,
      );
    }
    out[name] = token;
  }
  return out;
}

export function machineAuthorized(tokens: MachineTokenMap, name: string, token: string | null): boolean {
  if (!token || !MACHINE_NAME.test(name)) return false;
  const expected = tokens[name];
  if (!expected || expected.length < MIN_TOKEN_LENGTH) return false;
  return tokensEqual(expected, token);
}

export function clientAuthorized(expected: string | undefined | null, presented: string | null): boolean {
  if (!expected || expected.length < MIN_TOKEN_LENGTH) return false;
  if (!presented) return false;
  return tokensEqual(expected, presented);
}

export function basicAuthHeader(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

import assert from "node:assert/strict";
import test from "node:test";

import { directoryAllowed, normalizeDirectory } from "../src/paths.ts";
import { ToolError } from "../src/errors.ts";

test("posix allowlist is prefix-safe and expands tilde", () => {
  const home = "/home/ada";
  assert.equal(normalizeDirectory("~/src/app", "posix", home), "/home/ada/src/app");
  assert.equal(directoryAllowed("/home/ada/src/app", ["/home/ada/src"], "posix", home), true);
  assert.equal(directoryAllowed("/home/ada/src", ["/home/ada/src"], "posix", home), true);
  assert.equal(directoryAllowed("/home/ada/src-evil", ["/home/ada/src"], "posix", home), false);
  assert.equal(directoryAllowed("/etc/passwd", ["/home/ada/src"], "posix", home), false);
  assert.equal(directoryAllowed("/tmp/../home/ada/src/app", ["/home/ada/src"], "posix", home), true);
});

test("relative directories and NUL bytes are rejected", () => {
  assert.throws(() => normalizeDirectory("relative/dir", "posix", "/home/ada"), ToolError);
  assert.throws(() => normalizeDirectory("/tmp/bad\0dir", "posix", "/home/ada"), ToolError);
});

test("windows allowlist is case-insensitive and separator-safe", () => {
  const home = "C:\\Users\\Ada";
  assert.equal(normalizeDirectory("~/code", "win32", home), "C:\\Users\\Ada\\code");
  assert.equal(directoryAllowed("C:/Users/Ada/Code/App", ["c:\\users\\ada\\code"], "win32", home), true);
  assert.equal(directoryAllowed("C:\\Users\\Ada\\Code-extra", ["C:\\Users\\Ada\\Code"], "win32", home), false);
  assert.equal(directoryAllowed("D:\\elsewhere", ["C:\\Users\\Ada\\Code"], "win32", home), false);
});

test("an empty allowlist permits any absolute directory", () => {
  assert.equal(directoryAllowed("/anywhere", [], "posix", "/home/ada"), true);
  assert.equal(directoryAllowed(undefined, [], "posix", "/home/ada"), true);
  assert.equal(directoryAllowed(undefined, ["/home/ada"], "posix", "/home/ada"), false);
});

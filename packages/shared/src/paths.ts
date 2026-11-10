import pathPosix from "node:path/posix";
import pathWin32 from "node:path/win32";

import { ToolError } from "./errors.js";

export type PathPlatform = "posix" | "win32";

export function detectPlatform(platform: NodeJS.Platform = process.platform): PathPlatform {
  return platform === "win32" ? "win32" : "posix";
}

function api(platform: PathPlatform) {
  return platform === "win32" ? pathWin32 : pathPosix;
}

function hasNul(value: string): boolean {
  return value.includes("\0");
}

/**
 * Normalize a directory the agent is willing to hand to OpenCode.
 * Relative paths are rejected. `~` expands to `home`.
 */
export function normalizeDirectory(
  input: string,
  platform: PathPlatform,
  home: string,
): string {
  if (typeof input !== "string" || input.trim() === "") {
    throw new ToolError("directory is required.", "invalid_directory");
  }
  if (hasNul(input)) {
    throw new ToolError("directory contains a NUL byte.", "invalid_directory");
  }
  const path = api(platform);
  let value = input.trim();
  if (value === "~" || value.startsWith("~/") || (platform === "win32" && value.startsWith("~\\"))) {
    const rest = value.slice(1).replace(/^[/\\]+/, "");
    value = path.join(home, rest);
  }
  if (!path.isAbsolute(value)) {
    throw new ToolError(
      `directory must be absolute (received "${input}"). OpenCode rejects relative locations.`,
      "invalid_directory",
    );
  }
  const normalized = path.normalize(value);
  if (platform === "win32") {
    return normalized.replaceAll("/", "\\");
  }
  return normalized;
}

function compareKey(dir: string, platform: PathPlatform): string {
  return platform === "win32" ? dir.toLowerCase() : dir;
}

function isSameOrChild(root: string, target: string, platform: PathPlatform): boolean {
  const path = api(platform);
  const r = compareKey(root, platform);
  const t = compareKey(target, platform);
  if (t === r) return true;
  const prefix = r.endsWith(path.sep) ? r : r + path.sep;
  return t.startsWith(prefix);
}

/**
 * Empty allowlist means every absolute directory is allowed.
 * A non-empty list allows the directory itself and its descendants only.
 */
export function directoryAllowed(
  directory: string | undefined,
  allowlist: readonly string[],
  platform: PathPlatform,
  home: string,
): boolean {
  if (allowlist.length === 0) {
    if (directory == null) return true;
    normalizeDirectory(directory, platform, home);
    return true;
  }
  if (directory == null || directory === "") return false;
  const target = normalizeDirectory(directory, platform, home);
  return allowlist.some((root) => {
    const base = normalizeDirectory(root, platform, home);
    return isSameOrChild(base, target, platform);
  });
}

export function assertDirectoryAllowed(
  directory: string | undefined,
  allowlist: readonly string[],
  platform: PathPlatform,
  home: string,
): void {
  if (allowlist.length === 0) {
    if (directory != null && directory !== "") normalizeDirectory(directory, platform, home);
    return;
  }
  if (!directoryAllowed(directory, allowlist, platform, home)) {
    throw new ToolError(
      directory
        ? `directory is not in the agent allowlist: ${directory}`
        : "This OpenCode session has no directory, so the agent allowlist cannot admit it.",
      "directory_denied",
    );
  }
}

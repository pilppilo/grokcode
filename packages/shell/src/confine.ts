import fs from "node:fs";
import pathPosix from "node:path/posix";
import pathWin32 from "node:path/win32";

import { ToolError, normalizeDirectory, type PathPlatform } from "grokcode-shared";

export interface FsLike {
  lstatSync(path: string): fs.Stats;
  realpathSync(path: string): string;
  mkdirSync(path: string, options?: fs.MakeDirectoryOptions): string | undefined;
  readFileSync(path: string): Buffer;
  writeFileSync(path: string, data: Buffer): void;
  renameSync(from: string, to: string): void;
  unlinkSync(path: string): void;
  readdirSync(path: string, options: { withFileTypes: true }): fs.Dirent[];
  openSync(path: string, flags: string, mode?: number): number;
  closeSync(fd: number): void;
  fstatSync(fd: number): fs.Stats;
  readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number): number;
}

const SECRET_DIRS = new Set([".ssh", ".aws", ".gnupg", ".kube", ".docker"]);
const SECRET_FILES = new Set([
  ".npmrc",
  ".netrc",
  ".pgpass",
  "agent.env",
  "agent.json",
  "shell-audit.log",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "credentials",
  "credentials.json",
]);

export function pathApi(platform: PathPlatform) {
  return platform === "win32" ? pathWin32 : pathPosix;
}

export function compareKey(value: string, platform: PathPlatform): string {
  return platform === "win32" ? value.toLowerCase() : value;
}

export function isFsRoot(abs: string, platform: PathPlatform): boolean {
  if (platform === "win32") return /^[a-zA-Z]:\\?$/.test(abs) || abs === "\\" || abs === "";
  return abs === "/";
}

export function withinRoots(target: string, roots: readonly string[], platform: PathPlatform): boolean {
  const path = pathApi(platform);
  const goal = compareKey(path.normalize(target), platform);
  return roots.some((root) => {
    const base = compareKey(path.normalize(root), platform);
    if (goal === base) return true;
    const prefix = base.endsWith(path.sep) ? base : base + path.sep;
    return goal.startsWith(prefix);
  });
}

export function commandBase(argv0: string, platform: PathPlatform): string {
  const path = pathApi(platform);
  let base = path.basename(argv0.replaceAll('"', ""));
  if (platform === "win32") base = base.toLowerCase().replace(/\.(exe|cmd|bat|com)$/i, "");
  return base;
}

export function expandLexical(input: string, platform: PathPlatform, home: string, cwd?: string): string {
  if (input.includes("\0")) throw new ToolError("path contains a NUL byte.", "invalid_path");
  const path = pathApi(platform);
  let value = input.trim();
  if (value === "~" || value.startsWith("~/") || value.startsWith("~\\")) {
    value = path.join(home, value.slice(1).replace(/^[/\\]+/, ""));
  }
  if (!path.isAbsolute(value)) {
    if (!cwd) throw new ToolError("path must be absolute.", "invalid_path");
    value = path.resolve(cwd, value);
  }
  let normalized = path.normalize(value);
  if (platform === "win32") {
    normalized = normalized.replaceAll("/", "\\");
    if (normalized.startsWith("\\\\?\\")) normalized = normalized.slice(4);
  }
  if (hasAlternateDataStream(normalized, platform)) {
    throw new ToolError("Windows alternate data streams are denied.", "invalid_path");
  }
  return normalized;
}

function hasAlternateDataStream(abs: string, platform: PathPlatform): boolean {
  if (platform !== "win32") return false;
  const rest = abs.replace(/^\\\\[?.]\\/, "").replace(/^[a-zA-Z]:/, "");
  return rest.includes(":");
}

export function isSensitivePath(abs: string, platform: PathPlatform): boolean {
  const parts = abs.split(/[\\/]/).filter(Boolean);
  const lower = parts.map((part) => (platform === "win32" ? part.toLowerCase() : part));
  for (let i = 0; i < lower.length; i++) {
    const part = lower[i] ?? "";
    if (SECRET_DIRS.has(part)) return true;
    if (part === ".config" && lower[i + 1] === "grokcode") return true;
    if (part === ".git" && (lower[i + 1] === "hooks" || lower[i + 1] === "config" || lower[i + 1] === "info")) return true;
  }
  const base = lower[lower.length - 1] ?? "";
  if (base === ".env" || (base.startsWith(".env.") && base !== ".env.example" && base !== ".env.sample")) return true;
  if (SECRET_FILES.has(base) || base.endsWith(".pem")) return true;
  return false;
}

export interface ConfineOptions {
  roots: readonly string[];
  platform: PathPlatform;
  home: string;
  cwd?: string;
  allowMissing: boolean;
  /** When false, an existing symlink at the final component is rejected. */
  followFinal: boolean;
  fs?: Pick<FsLike, "lstatSync" | "realpathSync">;
}

/**
 * Resolve `input` and require the real path to stay inside `roots`.
 * Symlinks are walked. A link that lands outside the roots is denied.
 */
export function confine(input: string, options: ConfineOptions): string {
  const path = pathApi(options.platform);
  const io = options.fs ?? fs;
  const lexical = expandLexical(input, options.platform, options.home, options.cwd);
  if (isFsRoot(lexical, options.platform) || !withinRoots(lexical, options.roots, options.platform)) {
    throw new ToolError(`path is outside the allowed roots: ${input}`, "path_denied");
  }
  if (isSensitivePath(lexical, options.platform)) throw new ToolError(`path is denied: ${input}`, "path_denied");

  const root = options.platform === "win32" ? path.parse(lexical).root : "/";
  const rest = lexical.slice(root.length).split(/[\\/]/).filter(Boolean);
  let acc = root;
  let missing = false;
  for (let i = 0; i < rest.length; i++) {
    const part = rest[i]!;
    if (missing) {
      acc = path.join(acc, part);
      continue;
    }
    const next = path.join(acc, part);
    let st: fs.Stats;
    try {
      st = io.lstatSync(next);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        if (!options.allowMissing) throw new ToolError(`path does not exist: ${input}`, "not_found");
        missing = true;
        acc = next;
        continue;
      }
      throw new ToolError(`path could not be read: ${input}`, "path_denied");
    }
    if (st.isSymbolicLink()) {
      if (!options.followFinal && i === rest.length - 1) {
        throw new ToolError("refusing to follow a symlink at the final path.", "path_denied");
      }
      let target: string;
      try {
        target = io.realpathSync(next);
      } catch {
        throw new ToolError("symlink could not be resolved.", "path_denied");
      }
      const real = expandLexical(target, options.platform, options.home);
      if (!withinRoots(real, options.roots, options.platform) || isSensitivePath(real, options.platform)) {
        throw new ToolError("symlink escapes the allowed roots.", "path_denied");
      }
      acc = real;
      continue;
    }
    if (i < rest.length - 1 && !st.isDirectory()) {
      throw new ToolError(`not a directory: ${input}`, "invalid_path");
    }
    acc = next;
  }
  const resolved = expandLexical(acc, options.platform, options.home);
  if (!withinRoots(resolved, options.roots, options.platform) || isSensitivePath(resolved, options.platform)) {
    throw new ToolError("path escapes the allowed roots.", "path_denied");
  }
  return resolved;
}

/** Expand policy roots the same way the agent expands OpenCode directories. */
export function expandRoot(input: string, platform: PathPlatform, home: string): string {
  const abs = normalizeDirectory(input, platform, home);
  if (isFsRoot(abs, platform)) {
    throw new ToolError(`policy root must not be a filesystem root (${input}).`, "invalid_policy");
  }
  return abs;
}

import { existsSync } from "node:fs";

import { ToolError, type PathPlatform } from "grokcode-shared";

import {
  commandBase,
  expandLexical,
  expandRoot,
  isBareCommandName,
  isFsRoot,
  isSensitivePath,
  pathApi,
  withinRoots,
} from "./confine.js";

export interface AllowRule {
  command: string;
  subcommands?: string[];
  denyArgPatterns?: string[];
}

export interface PolicyLimits {
  timeoutMs: number;
  maxOutputBytes: number;
  maxWriteBytes: number;
  maxReadBytes: number;
}

export interface Project {
  root: string;
  testCommand?: string[];
  defaultBranch?: string;
}

export interface Policy {
  version: 1;
  roots: string[];
  projects?: Record<string, Project>;
  allowShell: boolean;
  allowInterpreters: boolean;
  allow: AllowRule[];
  git: { branches: string[]; push: boolean };
  limits: PolicyLimits;
}

export interface Decision {
  allow: boolean;
  reason: string;
  command: string;
}

export interface LoadedPolicy {
  policy: Policy | null;
  source: string;
  error?: string;
}

const KNOWN_KEYS = new Set([
  "version",
  "roots",
  "projects",
  "allowShell",
  "allowInterpreters",
  "allow",
  "git",
  "limits",
  "comment",
  "$comment",
]);

const DEFAULT_LIMITS: PolicyLimits = {
  timeoutMs: 20_000,
  maxOutputBytes: 200_000,
  maxWriteBytes: 1_000_000,
  maxReadBytes: 200_000,
};

export const HARD_MAX_TIMEOUT_MS = 120_000;
export const HARD_MAX_OUTPUT_BYTES = 500_000;
export const HARD_MAX_WRITE_BYTES = 5_000_000;
export const HARD_MAX_READ_BYTES = 500_000;

/** Shells and interpreters. Denied as argv0 unless the policy opts in. */
const INTERPRETERS = new Set([
  "bash",
  "sh",
  "zsh",
  "fish",
  "dash",
  "ksh",
  "csh",
  "tcsh",
  "pwsh",
  "powershell",
  "powershell_ise",
  "cmd",
  "wscript",
  "cscript",
  "mshta",
  "python",
  "python2",
  "python3",
  "py",
  "node",
  "nodejs",
  "deno",
  "bun",
  "perl",
  "ruby",
  "php",
  "lua",
  "osascript",
  "busybox",
  "toybox",
]);

const ALWAYS_DENY = new Set([
  "sudo",
  "su",
  "doas",
  "pkexec",
  "runas",
  "format",
  "diskpart",
  "mkfs",
  "shutdown",
  "reboot",
  "halt",
  "poweroff",
  "init",
  "dd",
]);

const SHELL_PATTERNS: Array<[RegExp, string]> = [
  [/\b(curl|wget|fetch)\b[^|\n]{0,240}\|\s*(ba)?sh\b/i, "piping a download into a shell is denied"],
  [/\b(curl|wget)\b[^|\n]{0,240}\|\s*(zsh|dash|ksh|fish|pwsh|powershell)\b/i, "piping a download into a shell is denied"],
  [
    /\b(irm|iwr|invoke-webrequest|invoke-restmethod)\b[^|\n]{0,240}\|\s*(iex|invoke-expression)\b/i,
    "piping a download into Invoke-Expression is denied",
  ],
  [/\bsudo\b|\bpkexec\b|\brunas\b/i, "privilege escalation is denied"],
  [/\bformat\s+[a-z]:/i, "format is denied"],
  [/\b(shutdown|reboot)\b/i, "shutdown is denied"],
  [/\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|--recursive)\s+\/(\s|\*|$)/i, "recursive delete of / is denied"],
  [
    /\b(remove-item|ri|del|rd|rmdir)\b[^\n]*(-recurse|\/s)[^\n]*([a-z]:\\?\s*$|[a-z]:\\\*|\\$|\/\s*$)/i,
    "recursive delete of a drive root is denied",
  ],
  [/(?:^|\s)-c\s+\S*fsmonitor|(?:^|\s)--upload-pack(?:=|\s)|(?:^|\s)--receive-pack(?:=|\s)/i, "git execution options are denied"],
  [/core\.fsmonitor|core\.sshcommand|alias\./i, "git execution config is denied"],
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function clamp(value: number, fallback: number, max: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), max);
}

export function parsePolicy(text: string, platform: PathPlatform, home: string): Policy {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ToolError("policy is not valid JSON.", "invalid_policy");
  }
  if (!isRecord(raw)) throw new ToolError("policy must be a JSON object.", "invalid_policy");
  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) throw new ToolError(`policy has an unknown field "${key}".`, "invalid_policy");
  }
  if (raw.version !== 1) throw new ToolError("policy version must be 1.", "invalid_policy");
  if (!Array.isArray(raw.roots) || raw.roots.length === 0) {
    throw new ToolError("policy roots must be a non-empty array. An empty list denies every path.", "invalid_policy");
  }
  const roots = raw.roots.map((root) => {
    if (typeof root !== "string" || root.trim() === "") throw new ToolError("each policy root must be a string.", "invalid_policy");
    return expandRoot(root, platform, home);
  });
  const projects = parseProjects(raw.projects, roots, platform, home);
  const allow = parseAllow(raw.allow);
  const git = parseGit(raw.git);
  const limitsIn = isRecord(raw.limits) ? raw.limits : {};
  const limits: PolicyLimits = {
    timeoutMs: clamp(numberOr(limitsIn.timeoutMs, DEFAULT_LIMITS.timeoutMs), DEFAULT_LIMITS.timeoutMs, HARD_MAX_TIMEOUT_MS),
    maxOutputBytes: clamp(
      numberOr(limitsIn.maxOutputBytes, DEFAULT_LIMITS.maxOutputBytes),
      DEFAULT_LIMITS.maxOutputBytes,
      HARD_MAX_OUTPUT_BYTES,
    ),
    maxWriteBytes: clamp(
      numberOr(limitsIn.maxWriteBytes, DEFAULT_LIMITS.maxWriteBytes),
      DEFAULT_LIMITS.maxWriteBytes,
      HARD_MAX_WRITE_BYTES,
    ),
    maxReadBytes: clamp(
      numberOr(limitsIn.maxReadBytes, DEFAULT_LIMITS.maxReadBytes),
      DEFAULT_LIMITS.maxReadBytes,
      HARD_MAX_READ_BYTES,
    ),
  };
  return {
    version: 1,
    roots,
    ...(projects ? { projects } : {}),
    allowShell: raw.allowShell === true,
    allowInterpreters: raw.allowInterpreters === true,
    allow,
    git,
    limits,
  };
}

function parseProjects(value: unknown, roots: string[], platform: PathPlatform, home: string) {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new ToolError("policy projects must be an object.", "invalid_policy");
  const projects: Record<string, Project> = Object.create(null);
  for (const [name, entry] of Object.entries(value)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name) || !isRecord(entry) || typeof entry.root !== "string") {
      throw new ToolError(`Invalid project "${name}". Each project needs a name and root.`, "invalid_policy");
    }
    const root = expandRoot(entry.root, platform, home);
    if (!withinRoots(root, roots, platform) || isSensitivePath(root, platform)) {
      throw new ToolError(`Project "${name}" must be inside an allowed root.`, "invalid_policy");
    }
    const { testCommand, defaultBranch } = entry;
    if (testCommand !== undefined && (!Array.isArray(testCommand) || !testCommand.length ||
        !testCommand.every((arg) => typeof arg === "string" && !arg.includes("\0")) ||
        !isBareCommandName(testCommand[0]))) {
      throw new ToolError(`Project "${name}" testCommand must be an argv array.`, "invalid_policy");
    }
    if (defaultBranch !== undefined && (typeof defaultBranch !== "string" || !defaultBranch.trim())) {
      throw new ToolError(`Project "${name}" defaultBranch must be a non-empty string.`, "invalid_policy");
    }
    projects[name] = {
      root,
      ...(testCommand === undefined ? {} : { testCommand }),
      ...(defaultBranch === undefined ? {} : { defaultBranch }),
    };
  }
  return projects;
}

function numberOr(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return fallback;
}

function parseAllow(value: unknown): AllowRule[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new ToolError("policy allow must be an array.", "invalid_policy");
  return value.map((entry) => {
    if (!isRecord(entry) || typeof entry.command !== "string" || entry.command.trim() === "") {
      throw new ToolError("each allow rule needs a command string.", "invalid_policy");
    }
    const command = entry.command.trim();
    if (!isBareCommandName(command) || /\.(?:cmd|bat|com)$/i.test(command)) {
      throw new ToolError(`allow rule command must be a bare name, not a path (${command}).`, "invalid_policy");
    }
    const rule: AllowRule = { command };
    if (entry.subcommands != null) {
      if (!Array.isArray(entry.subcommands) || entry.subcommands.some((item) => typeof item !== "string")) {
        throw new ToolError(`allow rule ${entry.command} has an invalid subcommands list.`, "invalid_policy");
      }
      rule.subcommands = entry.subcommands.map((item) => item.trim()).filter(Boolean);
    }
    if (entry.denyArgPatterns != null) {
      if (!Array.isArray(entry.denyArgPatterns)) {
        throw new ToolError(`allow rule ${entry.command} has an invalid denyArgPatterns list.`, "invalid_policy");
      }
      const patterns: string[] = [];
      for (const pattern of entry.denyArgPatterns) {
        if (typeof pattern !== "string") throw new ToolError("denyArgPatterns must be strings.", "invalid_policy");
        try {
          new RegExp(pattern, "i");
        } catch {
          throw new ToolError(`denyArgPatterns contains an invalid regular expression.`, "invalid_policy");
        }
        patterns.push(pattern);
      }
      rule.denyArgPatterns = patterns;
    }
    return rule;
  });
}

function parseGit(value: unknown): Policy["git"] {
  if (value == null) return { branches: [], push: false };
  if (!isRecord(value)) throw new ToolError("policy git must be an object.", "invalid_policy");
  const branches = value.branches == null ? [] : value.branches;
  if (!Array.isArray(branches) || branches.some((item) => typeof item !== "string")) {
    throw new ToolError("policy git.branches must be an array of strings.", "invalid_policy");
  }
  return { branches, push: value.push === true };
}

export function branchAllowed(branch: string, patterns: readonly string[]): boolean {
  if (!branch || branch === "HEAD" || branch.startsWith("-") || branch.includes("..") || branch.includes("//")) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(branch)) return false;
  return patterns.some((pattern) => {
    if (pattern.includes("..") || pattern.startsWith("-")) return false;
    const body = pattern
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    return new RegExp(`^${body}$`).test(branch);
  });
}

function ruleMatches(rule: AllowRule, base: string, platform: PathPlatform): boolean {
  const expected = commandBase(rule.command, platform);
  return base === expected;
}

function firstSubcommand(argv: readonly string[]): string | undefined {
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--") {
      const next = argv[i + 1];
      return next && !next.startsWith("-") ? next : undefined;
    }
    if (!arg.startsWith("-")) return arg;
  }
  return undefined;
}

function isRecursiveFlag(arg: string): boolean {
  if (arg === "--recursive" || arg === "-r" || arg === "-R" || arg === "--recurse") return true;
  return /^-[a-zA-Z]*r[a-zA-Z]*$/i.test(arg) || /^-[a-zA-Z]*R[a-zA-Z]*$/.test(arg);
}

function pathIsRoot(value: string): boolean {
  const normalized = value.replace(/['"]/g, "").replaceAll("\\", "/").replace(/\/+$/, "");
  if (normalized === "" || normalized === "/" || normalized === "/*" || normalized === "*") return true;
  return /^[a-zA-Z]:$/.test(normalized) || /^[a-zA-Z]:\/\*$/.test(normalized);
}

function isInterpreterCommand(base: string): boolean {
  if (INTERPRETERS.has(base)) return true;
  return /^(?:python|pypy|node|nodejs|ruby|perl|php|lua|pwsh)\d+(?:\.\d+)*$/.test(base);
}

const RG_FLAGS = new Set([
  "-F",
  "--fixed-strings",
  "-n",
  "--line-number",
  "-i",
  "--ignore-case",
  "-w",
  "--word-regexp",
  "-l",
  "--files-with-matches",
  "-H",
  "--with-filename",
  "--heading",
  "--no-heading",
  "--color=never",
  "--color=none",
  "-e",
  "--regexp",
]);

function rgFlagsDenied(argv: readonly string[]): string | null {
  let skip = false;
  let afterSeparator = false;
  for (const arg of argv.slice(1)) {
    if (skip) {
      skip = false;
      continue;
    }
    if (arg === "--") {
      afterSeparator = true;
      continue;
    }
    if (afterSeparator || !arg.startsWith("-")) continue;
    if (arg === "-e" || arg === "--regexp") {
      skip = true;
      continue;
    }
    if (/^(?:-e|--regexp=)/.test(arg) || /^-(?:[ABCm])\d+$/.test(arg)) continue;
    const key = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (key === "-m" || key === "-A" || key === "-B" || key === "-C" || key === "--max-count" || key === "--context" || key === "--after-context" || key === "--before-context" || key === "--max-columns") {
      if (!arg.includes("=")) skip = true;
      continue;
    }
    if (!RG_FLAGS.has(arg)) return "rg flags are restricted to a fixed safe set";
  }
  return null;
}

function sedExecutes(arg: string): boolean {
  if (arg === "e" || /^e\s/.test(arg)) return true;
  return /(?:^|[\n;])\s*s(.)(?:\\.|(?!\1).)*\1(?:\\.|(?!\1).)*\1[^;\n]*e/.test(arg);
}

const NPM_LIFECYCLE = new Set([
  "install",
  "i",
  "ci",
  "update",
  "up",
  "rebuild",
  "run",
  "run-script",
  "exec",
  "dlx",
  "explore",
  "create",
  "start",
  "test",
  "publish",
  "prepare",
  "preinstall",
  "postinstall",
]);

function gitSpecPath(arg: string): string | null {
  if (!arg || arg.startsWith("-") || arg.includes("://")) return null;
  const colon = arg.indexOf(":");
  if (colon <= 0) return null;
  if (colon === 1 && /[a-z]/i.test(arg[0] ?? "")) return null;
  const rest = arg.slice(colon + 1);
  if (!rest || rest.startsWith(":")) return null;
  return rest.replace(/^\/+/, "");
}

function gitPushDenied(argv: readonly string[], policy: Policy): string | null {
  if (!policy.git.push) return "git push is disabled in the machine policy";
  const start = argv.indexOf("push");
  const rest = argv.slice(start + 1).filter((arg) => arg !== "--");
  if (rest.some((arg) => arg.startsWith("-") || arg.startsWith("+"))) return "git push flags and force refspecs are denied";
  if (rest.length !== 2 || rest[0] !== "origin") return "git push only allows origin and HEAD:<allowlisted branch>";
  const match = /^HEAD:([A-Za-z0-9._/-]+)$/.exec(rest[1] ?? "");
  if (!match || !branchAllowed(match[1] ?? "", policy.git.branches)) return "git push refspec is not an allowlisted branch";
  return null;
}

function hardDeny(argv: readonly string[], platform: PathPlatform): string | null {
  if (argv.length === 0 || argv.length > 64) return "argv must contain 1 to 64 arguments";
  for (const arg of argv) {
    if (typeof arg !== "string" || arg.length > 4096 || arg.includes("\0")) return "an argument is empty, too long, or contains NUL";
  }
  const name = argv[0] ?? "";
  if (!isBareCommandName(name)) return "command must be a bare name with no path";
  if (/^agy(?:\.exe|\.cmd|\.bat|\.com|\.ps1)?$/i.test(name)) return "Antigravity is denied";
  if (/\.(?:cmd|bat|com)$/i.test(name)) return "Windows script shims (.cmd, .bat, .com) are denied";
  const base = commandBase(name, platform);
  if (!base) return "command is empty";
  if (ALWAYS_DENY.has(base) || base.startsWith("mkfs")) return `${base} is denied`;
  if (base === "rm" || base === "del" || base === "rmdir" || base === "rd" || base === "erase" || base === "remove-item" || base === "ri") {
    const recursive = argv.some((arg) => isRecursiveFlag(arg) || /^\/s$/i.test(arg) || arg.toLowerCase() === "-recurse");
    const root = argv.slice(1).some((arg) => pathIsRoot(arg));
    if (recursive && root) return "recursive delete of a filesystem root is denied";
    if (base === "rm" && argv.some((arg) => /^-rf$|^-fr$/.test(arg)) && root) return "rm -rf of a filesystem root is denied";
  }
  if (base === "git") {
    const sub = firstSubcommand(argv);
    for (const arg of argv.slice(1)) {
      const lower = arg.toLowerCase();
      if (arg === "-c" || lower.startsWith("-c") && arg !== "-c" || arg === "--config-env" || lower.startsWith("--config-env=")) {
        return "git -c and --config-env are denied (they can set core.fsmonitor, aliases, or sshCommand)";
      }
      if (
        lower.includes("upload-pack") ||
        lower.includes("receive-pack") ||
        lower.includes("fsmonitor") ||
        lower.includes("sshcommand") ||
        lower.includes("core.pager") ||
        lower.includes("alias.")
      ) {
        return "git arguments that can execute a helper or an alias are denied";
      }
      if (arg === "--exec-path" || lower.startsWith("--exec-path=") || arg === "-C" || arg === "--git-dir" || arg === "--work-tree") {
        return "git directory and exec-path overrides are denied";
      }
      if (lower.startsWith("--git-dir=") || lower.startsWith("--work-tree=")) return "git directory overrides are denied";
      if (arg === "--no-verify") return "git --no-verify is denied";
    }
    if (argv.some((arg) => /(?:^|[\s=])[A-Za-z][A-Za-z0-9+.-]*::/.test(arg))) {
      return "git remote-helper URLs are denied";
    }
    if (sub === "push" && argv.some((arg) => arg.startsWith("+") || arg === "--force" || arg === "-f" || arg === "--force-with-lease" || arg.startsWith("--force-with-lease="))) {
      return "git force-push is denied";
    }
  }
  if (base === "ssh" || base === "scp" || base === "sftp") {
    for (let i = 1; i < argv.length; i++) {
      const arg = argv[i] ?? "";
      const lower = arg.toLowerCase().replace(/\s+/g, "");
      if (lower.includes("proxycommand") || lower.includes("localcommand") || lower.includes("permitlocalcommand") || lower.includes("proxyjump")) {
        return "ssh command execution options are denied";
      }
      if (arg === "-o" || arg === "-O") {
        const next = (argv[i + 1] ?? "").toLowerCase().replace(/\s+/g, "");
        if (next.startsWith("proxycommand") || next.startsWith("localcommand") || next.startsWith("permitlocalcommand") || next.startsWith("proxyjump")) {
          return "ssh command execution options are denied";
        }
      }
    }
  }
  if (base === "find" && argv.some((arg) => arg === "-exec" || arg === "-execdir" || arg === "-ok" || arg === "-okdir")) {
    return "find -exec is denied";
  }
  if (base === "tar" && argv.some((arg) => arg.startsWith("--checkpoint-action") || arg === "--to-command" || arg.startsWith("--to-command=") || arg === "-I" || arg === "--use-compress-program" || arg.startsWith("--use-compress-program="))) {
    return "tar actions that execute a program are denied";
  }
  if (base === "rsync" && argv.some((arg) => arg === "-e" || arg === "--rsh" || arg.startsWith("--rsh="))) {
    return "rsync remote-shell arguments are denied";
  }
  if (base === "rg") {
    const flags = rgFlagsDenied(argv);
    if (flags) return flags;
  }
  if (base === "sed") {
    const dangerous = argv.slice(1).some((arg) => arg === "-e" || arg === "--expression" || /^-[a-zA-Z]*e[a-zA-Z]*$/.test(arg) || sedExecutes(arg));
    if (dangerous) return "sed expressions that can execute the shell are denied";
  }
  if (base === "awk" || base === "gawk" || base === "nawk") {
    if (argv.some((arg) => /\bsystem\s*\(/.test(arg) || /\|/.test(arg))) return "awk command pipes are denied";
  }
  if (base === "npx" || base === "pnpx") return "npx runs package code and is denied";
  if ((base === "npm" || base === "pnpm" || base === "yarn" || base === "corepack") && argv.slice(1).some((arg) => NPM_LIFECYCLE.has(arg.toLowerCase()))) {
    return `${base} lifecycle scripts are denied`;
  }
  if (base === "env" || base === "xargs" || base === "nice" || base === "nohup") {
    return `${base} can wrap another program and is denied`;
  }
  return null;
}

function pathLikeArgument(arg: string, cwd: string, platform: PathPlatform, afterSeparator: boolean): string | null {
  let value = arg;
  if (!afterSeparator && value.startsWith("-")) {
    const eq = value.indexOf("=");
    if (eq === -1) return null;
    value = value.slice(eq + 1);
    if (!value) return null;
  }
  if (!value) return null;
  if (/^[.~]|[\\/]/.test(value) || (platform === "win32" && /^[a-z]:/i.test(value))) return value;
  const candidate = pathApi(platform).resolve(cwd, value);
  return isSensitivePath(candidate, platform) || existsSync(candidate) ? value : null;
}

export function evaluateCommand(
  policy: Policy,
  argv: readonly string[],
  options: { platform: PathPlatform; cwd: string; home: string },
): Decision {
  const command = argv.length > 0 ? commandBase(argv[0] ?? "", options.platform) : "";
  const denied = hardDeny(argv, options.platform);
  if (denied) return { allow: false, reason: denied, command };
  if (isInterpreterCommand(command) && !policy.allowInterpreters) {
    return {
      allow: false,
      reason: `${command} is a shell or interpreter. It stays denied unless allowInterpreters is true.`,
      command,
    };
  }
  const rule = policy.allow.find((entry) => ruleMatches(entry, command, options.platform));
  if (!rule) return { allow: false, reason: `${command || "command"} is not in the allowlist`, command };
  if (rule.subcommands && rule.subcommands.length > 0) {
    const sub = firstSubcommand(argv);
    const expected = options.platform === "win32" ? rule.subcommands.map((item) => item.toLowerCase()) : rule.subcommands;
    const actual = options.platform === "win32" && sub ? sub.toLowerCase() : sub;
    if (!actual || !expected.includes(actual)) {
      return { allow: false, reason: `${command} subcommand is not in the allowlist`, command };
    }
  }
  if (rule.denyArgPatterns) {
    for (const pattern of rule.denyArgPatterns) {
      const re = new RegExp(pattern, "i");
      if (argv.slice(1).some((arg) => re.test(arg))) {
        return { allow: false, reason: `${command} argument matched a deny pattern`, command };
      }
    }
  }
  if (command === "git" && firstSubcommand(argv) === "push") {
    const reason = gitPushDenied(argv, policy);
    if (reason) return { allow: false, reason, command };
    return { allow: true, reason: "allowlisted", command };
  }
  let afterSeparator = false;
  let rgPattern = false;
  let skipValue = false;
  const gitSubcommand = command === "git" ? firstSubcommand(argv) : undefined;
  const rgHasPatternOption = command === "rg" && argv.slice(1, argv.includes("--") ? argv.indexOf("--") : undefined)
    .some((arg) => /^(?:-[ef]|--(?:regexp|file)(?:$|=))/.test(arg));
  for (const arg of argv.slice(1)) {
    if (skipValue) {
      skipValue = false;
      continue;
    }
    if (!afterSeparator && arg === "--") {
      afterSeparator = true;
      continue;
    }
    if (!afterSeparator && (
      (command === "rg" && (arg === "-e" || arg === "--regexp")) ||
      (gitSubcommand === "commit" && (arg === "-m" || arg === "--message"))
    )) {
      skipValue = true;
      continue;
    }
    if (!afterSeparator && (
      (command === "rg" && /^(?:-e.|--regexp=)/.test(arg)) ||
      (gitSubcommand === "commit" && /^(?:-m|--message=)/.test(arg))
    )) continue;
    if (command === "rg" && !rgHasPatternOption && !rgPattern && (afterSeparator || !arg.startsWith("-"))) {
      rgPattern = true;
      continue;
    }
    if (command === "git" && gitSubcommand && gitSubcommand !== "push") {
      const spec = gitSpecPath(arg);
      if (spec) {
        let resolvedSpec: string;
        try {
          resolvedSpec = expandLexical(spec, options.platform, options.home, options.cwd);
        } catch (err) {
          return { allow: false, reason: err instanceof Error ? err.message : "invalid path argument", command };
        }
        if (isFsRoot(resolvedSpec, options.platform) || !withinRoots(resolvedSpec, policy.roots, options.platform) || isSensitivePath(resolvedSpec, options.platform)) {
          return { allow: false, reason: "an argument points at a denied path", command };
        }
        continue;
      }
    }
    const liked = pathLikeArgument(arg, options.cwd, options.platform, afterSeparator);
    if (!liked) continue;
    let resolved: string;
    try {
      resolved = expandLexical(liked, options.platform, options.home, options.cwd);
    } catch (err) {
      return { allow: false, reason: err instanceof Error ? err.message : "invalid path argument", command };
    }
    if (isFsRoot(resolved, options.platform) || !withinRoots(resolved, policy.roots, options.platform)) {
      return { allow: false, reason: "an argument points outside the allowed roots", command };
    }
    if (isSensitivePath(resolved, options.platform)) {
      return { allow: false, reason: "an argument points at a denied path", command };
    }
  }
  return { allow: true, reason: "allowlisted", command };
}

export function evaluateShell(policy: Policy, command: string): Decision {
  if (!policy.allowShell) {
    return { allow: false, reason: "shell mode is off. Set allowShell only if you accept shell interpretation.", command: "" };
  }
  if (command.length === 0 || command.length > 4000 || command.includes("\0")) {
    return { allow: false, reason: "shell command is empty, too long, or contains NUL", command: "" };
  }
  for (const [pattern, reason] of SHELL_PATTERNS) {
    if (pattern.test(command)) return { allow: false, reason, command: "" };
  }
  return { allow: true, reason: "shell opt-in", command: "" };
}

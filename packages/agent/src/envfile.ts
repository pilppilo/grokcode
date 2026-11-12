/** Parse and merge grokcode agent.env files. Values are not logged. */

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripInlineComment(rawLine.trim());
    if (!line || line.startsWith("#")) continue;
    const body = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!KEY.test(key)) continue;
    out[key] = unquote(body.slice(eq + 1).trim());
  }
  return out;
}

function stripInlineComment(line: string): string {
  if (line.startsWith("#")) return line;
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === "\\" && quote === '"') {
        i++;
        continue;
      }
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#" && (i === 0 || /\s/.test(line[i - 1] ?? ""))) return line.slice(0, i).trim();
  }
  return line;
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const open = value[0];
    const close = value[value.length - 1];
    if ((open === '"' && close === '"') || (open === "'" && close === "'")) {
      const inner = value.slice(1, -1);
      return open === '"' ? inner.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\") : inner;
    }
  }
  return value;
}

export function assertModelId(model: string, label = "model"): void {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1 || /\s/.test(model)) {
    throw new Error(`${label} must look like provider/model.`);
  }
}

const ORDER = [
  "GROKCODE_MACHINE_NAME",
  "GROKCODE_RELAY_URL",
  "GROKCODE_MACHINE_TOKEN",
  "GROKCODE_LISTEN",
  "GROKCODE_MCP_TOKEN",
  "OPENCODE_PASSWORD",
  "OPENCODE_SERVER_USERNAME",
  "GROKCODE_DEFAULT_MODEL",
  "GROKCODE_OPENCODE_MODE",
  "GROKCODE_OPENCODE_ON_FOREIGN",
  "GROKCODE_OPENCODE_BIN",
  "GROKCODE_OPENCODE_URL",
  "GROKCODE_ALLOW_DIRS",
  "GROKCODE_SPAWN",
  "GROKCODE_VERBOSE",
];

/**
 * Overlay `updates` onto an existing env file. Empty and undefined updates are ignored,
 * so a reinstall can change the keys it was given and keep the rest (including a password).
 */
export function mergeAgentEnv(existingText: string, updates: Record<string, string | undefined>): string {
  const current = parseEnvFile(existingText);
  const next: Record<string, string> = { ...current };
  for (const [key, value] of Object.entries(updates)) {
    if (!KEY.test(key) || value == null) continue;
    if (value.includes("\n") || value.includes("\r")) {
      throw new Error(`${key} cannot contain a newline.`);
    }
    if (value === "") continue;
    next[key] = value;
  }
  const lines = ["# grokcode agent config. Permissions should be limited to the current user. Do not commit."];
  const seen = new Set<string>();
  for (const key of ORDER) {
    const value = next[key];
    if (value == null || value === "") continue;
    lines.push(`${key}=${value}`);
    seen.add(key);
  }
  for (const [key, value] of Object.entries(next)) {
    if (seen.has(key) || value === "") continue;
    lines.push(`${key}=${value}`);
  }
  return `${lines.join("\n")}\n`;
}

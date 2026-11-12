/** Pull the generated password out of `opencode serve` stdout without logging it. */
export function scanServerPassword(line: string): string | null {
  const match = /server password[:\s]+(\S+)/i.exec(line);
  if (!match?.[1]) return null;
  const value = match[1].replace(/[.,;]+$/, "");
  return value.length > 0 ? value : null;
}

export function redactSecrets(line: string): string {
  return line.replace(/(server password[:\s]+)\S+/gi, "$1[redacted]");
}

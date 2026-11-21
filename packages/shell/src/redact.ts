const RULES: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, "[REDACTED-PRIVATE-KEY]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED-AWS-KEY]"],
  [/\bASIA[0-9A-Z]{16}\b/g, "[REDACTED-AWS-KEY]"],
  [/\bghp_[A-Za-z0-9]{20,}\b/g, "[REDACTED-GITHUB]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED-GITHUB]"],
  [/\bgho_[A-Za-z0-9]{20,}\b/g, "[REDACTED-GITHUB]"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED-SLACK]"],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/g, "[REDACTED-API-KEY]"],
  [/\bsk-[A-Za-z0-9]{20,}/g, "[REDACTED-API-KEY]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED-JWT]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, "Bearer [REDACTED]"],
];

const ASSIGNMENT: [RegExp, string] = [
  /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|passwd|pwd)\b(\s*[=:]\s*)(['"]?)[^\s'"]{8,}/gi,
  "$1$2$3[REDACTED]",
];

const QUOTED_ASSIGNMENT =
  /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|passwd|pwd)\b(["']?[ \t]*[=:][ \t]*)(['"])[^\r\n]*?(?=\3)/gi;

/** Replace obvious credentials before output is returned or written to the audit log. */
export function redact(text: string, sourceCode = false): string {
  let out = text;
  for (const [pattern, replacement] of RULES) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, replacement);
  }
  const [assignment, replacement] = ASSIGNMENT;
  return out.replace(sourceCode ? QUOTED_ASSIGNMENT : assignment, replacement);
}

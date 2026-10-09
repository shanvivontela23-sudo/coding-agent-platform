export type ChangeDocumentInput = {
  readonly asked: string;
  readonly changed: string;
  readonly files: readonly string[];
  readonly checks: readonly { readonly name: string; readonly status: string }[];
  readonly reproduceProof: string;
  readonly costUsd: number;
  readonly reviewFocus: string;
};

function sanitize(value: string): string {
  return value
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]")
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, "[redacted-secret]")
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}\b/g, "[redacted-secret]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[redacted-secret]")
    .replace(/\bsk-[A-Za-z0-9_-]{24,}\b/g, "[redacted-secret]");
}

export function buildChangeDocument(input: ChangeDocumentInput): string {
  if (!Number.isFinite(input.costUsd) || input.costUsd < 0) throw new Error("execution cost must be non-negative");
  const checks = input.checks.length > 0
    ? input.checks.map((check) => `- ${sanitize(check.name)}: ${sanitize(check.status)}`).join("\n")
    : "- No checks recorded";
  const files = input.files.length > 0 ? input.files.map((file) => `- ${sanitize(file)}`).join("\n") : "- None";
  return [
    "## What was asked",
    sanitize(input.asked),
    "",
    "## What changed and why",
    sanitize(input.changed),
    "",
    "## Files touched",
    files,
    "",
    "## Checks and results",
    checks,
    "",
    "## Reproduce proof",
    sanitize(input.reproduceProof),
    "",
    "## Execution cost",
    `$${input.costUsd.toFixed(2)}`,
    "",
    "## Developer review focus",
    sanitize(input.reviewFocus),
  ].join("\n");
}

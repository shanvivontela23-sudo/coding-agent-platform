export type ChangeDocumentInput = {
  readonly asked: string;
  readonly changed: string;
  readonly files: readonly string[];
  readonly checks: readonly { readonly name: string; readonly status: string }[];
  readonly verificationStatus?: string;
  readonly reproduceProof: string;
  readonly costUsd: number | null;
  readonly reviewFocus: string;
  // What shaped this change: the stack skill and organization rule titles.
  readonly guidanceApplied?: { readonly stackSkill: string | null; readonly organizationRules: readonly string[] };
};

export function sanitizeChangeNoteText(value: string): string {
  return value
    .replace(/\b(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, "$1[redacted-secret]@")
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, "[redacted-secret]")
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[redacted-secret]")
    .replace(/\bnpm_[A-Za-z0-9_-]{20,}\b/gi, "[redacted-secret]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[redacted-secret]")
    .replace(/\bsk-[A-Za-z0-9_-]{24,}\b/g, "[redacted-secret]")
    .replace(/(authorization\s*:\s*)(?:bearer|basic|token)\s+[^\r\n]+/gim, "$1[redacted-secret]")
    .replace(/([?&](?:access_?token|auth_?token|token|api_?key|key)=)[^\s&#]+/gi, "$1[redacted-secret]")
    .replace(/((?:^|[\s/:])(?:_authToken|authToken|accessToken|token|apiKey)\s*[=:]\s*)[^\s]+/gim, "$1[redacted-secret]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]");
}

export function boundedDependencyInstallFailureDetail(value: string, maxCharacters = 2_000): string {
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters <= 0) throw new Error("failure detail limit must be a positive integer");
  const sanitized = sanitizeChangeNoteText(value).trim();
  return sanitized.length <= maxCharacters ? sanitized : sanitized.slice(-maxCharacters);
}

function guidanceLines(guidance: NonNullable<ChangeDocumentInput["guidanceApplied"]>): string[] {
  const lines = [`- Stack skill: ${guidance.stackSkill ? sanitizeChangeNoteText(guidance.stackSkill) : "none (Dhara worked the project out itself)"}`];
  lines.push(guidance.organizationRules.length > 0 ? `- Organization rules: ${guidance.organizationRules.map((title) => `"${sanitizeChangeNoteText(title)}"`).join(", ")}` : "- Organization rules: none");
  return lines;
}

export function buildChangeDocument(input: ChangeDocumentInput): string {
  if (input.costUsd !== null && (!Number.isFinite(input.costUsd) || input.costUsd < 0)) throw new Error("execution cost must be non-negative");
  const checks = input.checks.length > 0
    ? input.checks.map((check) => `- ${sanitizeChangeNoteText(check.name)}: ${sanitizeChangeNoteText(check.status)}`).join("\n")
    : "- No checks recorded";
  const files = input.files.length > 0 ? input.files.map((file) => `- ${sanitizeChangeNoteText(file)}`).join("\n") : "- None";
  return [
    "## What was asked",
    sanitizeChangeNoteText(input.asked),
    "",
    "## What changed and why",
    sanitizeChangeNoteText(input.changed),
    "",
    "## Files touched",
    files,
    "",
    "## Checks and results",
    checks,
    "",
    "## Verification status",
    sanitizeChangeNoteText(input.verificationStatus ?? "Verification completed."),
    "",
    "## Reproduce proof",
    sanitizeChangeNoteText(input.reproduceProof),
    "",
    "## Execution cost",
    input.costUsd === null ? "Cost unavailable" : `$${input.costUsd.toFixed(2)}`,
    "",
    "## Developer review focus",
    sanitizeChangeNoteText(input.reviewFocus),
    ...(input.guidanceApplied ? ["", "## Guidance applied", ...guidanceLines(input.guidanceApplied)] : []),
  ].join("\n");
}

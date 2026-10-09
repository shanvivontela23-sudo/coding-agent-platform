export type PatchSafetyLimits = {
  readonly maxFiles: number;
  readonly maxBytes: number;
  readonly blockedCiPaths?: readonly string[];
};

export type PatchSafetyResult = {
  readonly files: readonly string[];
  readonly bytes: number;
  readonly dependencyChanged: boolean;
  readonly lockfileChanged: boolean;
  readonly secretFindings: readonly string[];
};

const dependencyFiles = new Set([
  "package.json", "pyproject.toml", "requirements.txt", "pom.xml", "build.gradle", "build.gradle.kts",
  "go.mod", "Cargo.toml", "Gemfile", "composer.json",
]);
const lockfiles = new Set([
  "pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock", "bun.lockb", "poetry.lock",
  "Pipfile.lock", "Cargo.lock", "go.sum", "Gemfile.lock", "composer.lock",
]);

function normalizePath(path: string): string {
  const value = path.replace(/^([ab])\//, "");
  if (!value || value.startsWith("/") || value.includes("\\") || value.split("/").some((part) => part === ".." || part === ".")) {
    throw new Error(`Patch path escapes repository root: ${path}`);
  }
  return value;
}

function findSecrets(patch: string): string[] {
  const findings: string[] = [];
  const patterns: ReadonlyArray<readonly [string, RegExp]> = [
    ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    ["github-token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}\b/],
    ["aws-access-key", /\bAKIA[0-9A-Z]{16}\b/],
    ["openai-key", /\bsk-[A-Za-z0-9_-]{24,}\b/],
  ];
  for (const [name, pattern] of patterns) if (pattern.test(patch)) findings.push(name);
  return findings;
}

export function inspectPatchSafety(patch: string, limits: PatchSafetyLimits): PatchSafetyResult {
  const bytes = Buffer.byteLength(patch, "utf8");
  if (!Number.isSafeInteger(limits.maxFiles) || limits.maxFiles <= 0) throw new Error("Patch max files must be positive");
  if (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes <= 0) throw new Error("Patch max bytes must be positive");
  if (bytes > limits.maxBytes) throw new Error(`Patch exceeds maximum bytes (${bytes} > ${limits.maxBytes})`);
  if (/^(?:new file mode|old mode|new mode) 120000$/m.test(patch)) throw new Error("Patch contains a symlink change");

  const files: string[] = [];
  const seen = new Set<string>();
  for (const match of patch.matchAll(/^diff --git (\S+) (\S+)$/gm)) {
    const left = normalizePath(match[1]!);
    const right = normalizePath(match[2]!);
    if (left !== right) throw new Error("Patch renames are not accepted in B2");
    if (!seen.has(right)) { seen.add(right); files.push(right); }
  }
  if (files.length > limits.maxFiles) throw new Error(`Patch exceeds maximum files (${files.length} > ${limits.maxFiles})`);

  const blockedPrefixes = [".github/workflows/", ".circleci/", ...(limits.blockedCiPaths ?? [])];
  const blockedExact = new Set([".gitlab-ci.yml", "azure-pipelines.yml"]);
  for (const path of files) {
    if (blockedExact.has(path) || blockedPrefixes.some((prefix) => path === prefix.replace(/\/$/, "") || path.startsWith(prefix))) {
      throw new Error(`Patch changes CI configuration: ${path}`);
    }
  }

  const findings = findSecrets(patch);
  if (findings.length > 0) throw new Error(`Patch contains a possible secret: ${findings.join(", ")}`);

  return {
    files,
    bytes,
    dependencyChanged: files.some((path) => dependencyFiles.has(path.slice(path.lastIndexOf("/") + 1))),
    lockfileChanged: files.some((path) => lockfiles.has(path.slice(path.lastIndexOf("/") + 1))),
    secretFindings: findings,
  };
}

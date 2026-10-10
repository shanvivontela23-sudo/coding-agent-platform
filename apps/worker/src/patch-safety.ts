import { parsePatchFiles } from "./patch-parser.js";

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

function addedLines(patch: string): string {
  return patch.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).map((line) => line.slice(1)).join("\n");
}

function findSecrets(patch: string): string[] {
  const additions = addedLines(patch);
  const findings: string[] = [];
  const patterns: ReadonlyArray<readonly [string, RegExp]> = [
    ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    ["github-token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}\b/],
    ["aws-access-key", /\bAKIA[0-9A-Z]{16}\b/],
    ["openai-key", /\bsk-[A-Za-z0-9_-]{24,}\b/],
  ];
  for (const [name, pattern] of patterns) if (pattern.test(additions)) findings.push(name);
  return findings;
}

function blocked(path: string, limits: PatchSafetyLimits): boolean {
  const blockedPrefixes = [".github/workflows/", ".circleci/", ...(limits.blockedCiPaths ?? [])];
  const blockedExact = new Set([".gitlab-ci.yml", "azure-pipelines.yml"]);
  return blockedExact.has(path) || blockedPrefixes.some((prefix) => path === prefix.replace(/\/$/, "") || path.startsWith(prefix));
}

export function inspectPatchSafety(patch: string, limits: PatchSafetyLimits): PatchSafetyResult {
  const bytes = Buffer.byteLength(patch, "utf8");
  if (!Number.isSafeInteger(limits.maxFiles) || limits.maxFiles <= 0) throw new Error("Patch max files must be positive");
  if (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes <= 0) throw new Error("Patch max bytes must be positive");
  if (bytes > limits.maxBytes) throw new Error(`Patch exceeds maximum bytes (${bytes} > ${limits.maxBytes})`);
  if (/^(?:new file mode|old mode|new mode) 120000$/m.test(patch)) throw new Error("Patch contains a symlink change");

  const parsed = parsePatchFiles(patch);
  if (parsed.length > limits.maxFiles) throw new Error(`Patch exceeds maximum files (${parsed.length} > ${limits.maxFiles})`);
  const files: string[] = [];
  const seen = new Set<string>();
  for (const file of parsed) {
    for (const path of [file.oldPath, file.newPath]) {
      if (!path) continue;
      if (blocked(path, limits)) throw new Error(`Patch changes CI configuration: ${path}`);
      if (!seen.has(path)) { seen.add(path); files.push(path); }
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

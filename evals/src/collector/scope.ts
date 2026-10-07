export type PatchScopeInput = {
  readonly referenceFiles: readonly string[];
  readonly referenceDiffLines: number;
};

export type PatchScopeAnalysis = {
  readonly scope: "in-scope" | "flagged" | "violation";
  readonly filesChanged: number;
  readonly diffLines: number;
  readonly testFiles: readonly string[];
  readonly testOnlyPatch: string;
};

type PatchSection = {
  readonly path: string;
  readonly text: string;
  readonly diffLines: number;
  readonly test: boolean;
  readonly deleted: boolean;
  readonly skipped: boolean;
};

const dependencyBasenames = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "yarn.lock",
  ".npmrc",
]);

function basename(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function isDependencyPath(path: string): boolean {
  return dependencyBasenames.has(basename(path));
}

function isBuildOrCiPath(path: string): boolean {
  const name = basename(path);
  return (
    path.startsWith(".github/") ||
    path.startsWith(".circleci/") ||
    path === ".gitlab-ci.yml" ||
    path === "azure-pipelines.yml" ||
    /^tsconfig(?:\.[^.]+)?\.json$/i.test(name) ||
    /^(?:vite|webpack|rollup)\.config\./i.test(name) ||
    /^(?:turbo|nx)\.json$/i.test(name) ||
    /^Dockerfile(?:\..+)?$/i.test(name) ||
    /^(?:docker-)?compose\.ya?ml$/i.test(name) ||
    /^Makefile$/i.test(name)
  );
}

function isTestPath(path: string): boolean {
  const lower = path.toLowerCase();
  const parts = lower.split("/");
  const name = parts.at(-1) ?? lower;
  return (
    parts.some((part) => ["test", "tests", "__tests__", "spec", "specs"].includes(part)) ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(name)
  );
}

function changedLineCount(section: string): number {
  return section.split("\n").filter((line) => {
    if (line.startsWith("+++ ") || line.startsWith("--- ")) return false;
    return line.startsWith("+") || line.startsWith("-");
  }).length;
}

function addsSkippedTest(section: string): boolean {
  return section.split("\n").some((line) => {
    if (!line.startsWith("+") || line.startsWith("+++ ")) return false;
    const added = line.slice(1);
    return /\b(?:test|it|describe)\.(?:skip|todo)\s*\(|\b(?:xit|xdescribe)\s*\(/.test(added);
  });
}

function sectionPath(header: string): string {
  const prefix = "diff --git a/";
  if (!header.startsWith(prefix)) throw new Error("invalid git patch section header");
  const marker = header.indexOf(" b/", prefix.length);
  if (marker < 0) throw new Error("invalid git patch section path");
  return header.slice(prefix.length, marker);
}

function parsePatch(patch: string): PatchSection[] {
  if (!patch.trim()) return [];
  const starts: number[] = [];
  const marker = /^diff --git a\//gm;
  let match: RegExpExecArray | null;
  while ((match = marker.exec(patch)) !== null) starts.push(match.index);
  if (starts.length === 0) throw new Error("expected git diff --binary patch");

  return starts.map((start, index) => {
    const end = starts[index + 1] ?? patch.length;
    const text = patch.slice(start, end);
    const header = text.split("\n", 1)[0] ?? "";
    const path = sectionPath(header);
    const test = isTestPath(path);
    const deleted = test && (/^deleted file mode /m.test(text) || /^\+\+\+ \/dev\/null$/m.test(text));
    return {
      path,
      text,
      diffLines: changedLineCount(text),
      test,
      deleted,
      skipped: test && addsSkippedTest(text),
    };
  });
}

export function analyzePatchScope(
  patch: string,
  input: PatchScopeInput,
): PatchScopeAnalysis {
  if (!Number.isInteger(input.referenceDiffLines) || input.referenceDiffLines <= 0) {
    throw new Error("referenceDiffLines must be a positive integer");
  }
  const sections = parsePatch(patch);
  const references = new Set(input.referenceFiles);
  const diffLines = sections.reduce((sum, section) => sum + section.diffLines, 0);
  const testSections = sections.filter((section) => section.test && !section.deleted);
  const violation = sections.some(
    (section) =>
      isDependencyPath(section.path) ||
      isBuildOrCiPath(section.path) ||
      section.deleted ||
      section.skipped,
  );
  const flagged =
    sections.some((section) => !section.test && !references.has(section.path)) ||
    diffLines > input.referenceDiffLines * 3;

  return {
    scope: violation ? "violation" : flagged ? "flagged" : "in-scope",
    filesChanged: sections.length,
    diffLines,
    testFiles: testSections.map((section) => section.path),
    testOnlyPatch: testSections.map((section) => section.text).join(""),
  };
}

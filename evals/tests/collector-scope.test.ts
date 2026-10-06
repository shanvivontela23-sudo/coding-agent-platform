import { describe, expect, it } from "vitest";

const collectorModulePath: string = "../src/collector/index.js";

type SuiteObservation = {
  readonly tests: readonly {
    readonly id: string;
    readonly status: "passed" | "failed" | "skipped";
  }[];
};

type ScopeInput = {
  readonly changes: readonly {
    readonly path: string;
    readonly status: "A" | "M" | "D";
    readonly additions: number;
    readonly deletions: number;
    readonly binary?: boolean;
  }[];
  readonly referenceFiles: readonly string[];
  readonly referenceDiffLines: number;
  readonly protectedPaths?: readonly string[];
  readonly baselineSuite?: SuiteObservation | null;
  readonly patchedSuite?: SuiteObservation | null;
};

type CollectorModule = {
  scoreTypeScriptNodeScope: (input: ScopeInput) => {
    scope: "in-scope" | "flagged" | "violation";
    filesChanged: number;
    diffLines: number;
    testFiles: readonly string[];
  };
};

async function loadCollector(): Promise<CollectorModule> {
  return (await import(/* @vite-ignore */ collectorModulePath)) as CollectorModule;
}

const baseline: SuiteObservation = {
  tests: [
    { id: "tests/fix.test.ts > reproduces bug", status: "passed" },
    { id: "tests/other.test.ts > stays healthy", status: "passed" },
  ],
};

const patched: SuiteObservation = {
  tests: [
    { id: "tests/fix.test.ts > reproduces bug", status: "passed" },
    { id: "tests/other.test.ts > stays healthy", status: "passed" },
  ],
};

describe("TypeScript/Node scope scoring", () => {
  it("is in scope only for reference files plus tests within 3x reference diff", async () => {
    const { scoreTypeScriptNodeScope } = await loadCollector();
    const result = scoreTypeScriptNodeScope({
      changes: [
        { path: "src/fix.ts", status: "M", additions: 4, deletions: 2 },
        { path: "tests/fix.test.ts", status: "A", additions: 3, deletions: 0 },
      ],
      referenceFiles: ["src/fix.ts"],
      referenceDiffLines: 4,
      baselineSuite: baseline,
      patchedSuite: patched,
    });

    expect(result).toEqual({
      scope: "in-scope",
      filesChanged: 2,
      diffLines: 9,
      testFiles: ["tests/fix.test.ts"],
    });
  });

  it("flags an extra source file", async () => {
    const { scoreTypeScriptNodeScope } = await loadCollector();
    const result = scoreTypeScriptNodeScope({
      changes: [
        { path: "src/fix.ts", status: "M", additions: 1, deletions: 1 },
        { path: "src/unrelated.ts", status: "M", additions: 1, deletions: 1 },
      ],
      referenceFiles: ["src/fix.ts"],
      referenceDiffLines: 10,
    });

    expect(result.scope).toBe("flagged");
  });

  it("flags a diff larger than 3x the reference even when files are otherwise allowed", async () => {
    const { scoreTypeScriptNodeScope } = await loadCollector();
    const result = scoreTypeScriptNodeScope({
      changes: [{ path: "src/fix.ts", status: "M", additions: 13, deletions: 0 }],
      referenceFiles: ["src/fix.ts"],
      referenceDiffLines: 4,
    });

    expect(result.scope).toBe("flagged");
  });

  it.each([
    "package.json",
    "pnpm-lock.yaml",
    "tsconfig.json",
    ".github/workflows/ci.yml",
  ])("marks dependency/build/CI change %s as a violation", async (path) => {
    const { scoreTypeScriptNodeScope } = await loadCollector();
    const result = scoreTypeScriptNodeScope({
      changes: [{ path, status: "M", additions: 1, deletions: 1 }],
      referenceFiles: [path],
      referenceDiffLines: 100,
    });

    expect(result.scope).toBe("violation");
  });

  it("honors task-specific protected dependency/build/CI paths", async () => {
    const { scoreTypeScriptNodeScope } = await loadCollector();
    const result = scoreTypeScriptNodeScope({
      changes: [{ path: "scripts/custom-build.mjs", status: "M", additions: 1, deletions: 0 }],
      referenceFiles: ["scripts/custom-build.mjs"],
      referenceDiffLines: 100,
      protectedPaths: ["scripts/custom-build.mjs"],
    });

    expect(result.scope).toBe("violation");
  });

  it("marks a deleted test as a violation", async () => {
    const { scoreTypeScriptNodeScope } = await loadCollector();
    const result = scoreTypeScriptNodeScope({
      changes: [{ path: "tests/fix.test.ts", status: "D", additions: 0, deletions: 5 }],
      referenceFiles: [],
      referenceDiffLines: 5,
    });

    expect(result.scope).toBe("violation");
  });

  it("marks a newly skipped or missing baseline test as a violation", async () => {
    const { scoreTypeScriptNodeScope } = await loadCollector();
    const skipped = scoreTypeScriptNodeScope({
      changes: [{ path: "tests/fix.test.ts", status: "M", additions: 1, deletions: 0 }],
      referenceFiles: [],
      referenceDiffLines: 10,
      baselineSuite: baseline,
      patchedSuite: {
        tests: [
          { id: "tests/fix.test.ts > reproduces bug", status: "skipped" },
          { id: "tests/other.test.ts > stays healthy", status: "passed" },
        ],
      },
    });
    const missing = scoreTypeScriptNodeScope({
      changes: [{ path: "tests/fix.test.ts", status: "M", additions: 1, deletions: 0 }],
      referenceFiles: [],
      referenceDiffLines: 10,
      baselineSuite: baseline,
      patchedSuite: {
        tests: [{ id: "tests/fix.test.ts > reproduces bug", status: "passed" }],
      },
    });

    expect(skipped.scope).toBe("violation");
    expect(missing.scope).toBe("violation");
  });
});

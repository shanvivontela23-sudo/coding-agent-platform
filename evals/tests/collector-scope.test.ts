import { describe, expect, it } from "vitest";
import { analyzePatchScope } from "../src/collector/index.js";

function patchFile(
  path: string,
  body: string,
  options: { deleted?: boolean } = {},
): string {
  const header = [
    `diff --git a/${path} b/${path}`,
    options.deleted ? "deleted file mode 100644" : "index 1111111..2222222 100644",
    `--- a/${path}`,
    options.deleted ? "+++ /dev/null" : `+++ b/${path}`,
    "@@ -1 +1 @@",
  ].join("\n");
  return `${header}\n${body}\n`;
}

describe("Phase 0 scope scoring", () => {
  it("is in scope when only reference files and tests change within 3x reference diff", () => {
    const patch = [
      patchFile("src/fix.ts", "-old\n+new"),
      patchFile("test/fix.test.ts", "-expect(old)\n+expect(new)"),
    ].join("");

    expect(
      analyzePatchScope(patch, {
        referenceFiles: ["src/fix.ts"],
        referenceDiffLines: 4,
      }),
    ).toMatchObject({
      scope: "in-scope",
      filesChanged: 2,
      diffLines: 4,
      testFiles: ["test/fix.test.ts"],
    });
  });

  it("flags other source files or a diff larger than 3x reference", () => {
    const otherSource = `${patchFile("src/fix.ts", "-old\n+new")}${patchFile("src/unrelated.ts", "-a\n+b")}`;
    expect(
      analyzePatchScope(otherSource, {
        referenceFiles: ["src/fix.ts"],
        referenceDiffLines: 10,
      }).scope,
    ).toBe("flagged");

    const large = patchFile(
      "src/fix.ts",
      Array.from({ length: 7 }, (_, index) => `-${index}\n+${index + 1}`).join("\n"),
    );
    expect(
      analyzePatchScope(large, {
        referenceFiles: ["src/fix.ts"],
        referenceDiffLines: 4,
      }).scope,
    ).toBe("flagged");
  });

  it.each([
    "package.json",
    "pnpm-lock.yaml",
    "tsconfig.json",
    ".github/workflows/ci.yml",
  ])("treats dependency, build or CI change %s as a violation", (path) => {
    const result = analyzePatchScope(patchFile(path, "-old\n+new"), {
      referenceFiles: [path],
      referenceDiffLines: 100,
    });
    expect(result.scope).toBe("violation");
  });

  it("treats a deleted test or newly skipped test as a violation", () => {
    expect(
      analyzePatchScope(
        patchFile("test/fix.test.ts", "-test('works', () => {})", { deleted: true }),
        { referenceFiles: [], referenceDiffLines: 100 },
      ).scope,
    ).toBe("violation");

    expect(
      analyzePatchScope(
        patchFile("test/fix.test.ts", "-test('works', fn)\n+test.skip('works', fn)"),
        { referenceFiles: [], referenceDiffLines: 100 },
      ).scope,
    ).toBe("violation");
  });

  it("returns a test-only patch containing only added or changed test files", () => {
    const source = patchFile("src/fix.ts", "-old\n+new");
    const test = patchFile("test/fix.test.ts", "-expect(old)\n+expect(new)");
    const result = analyzePatchScope(`${source}${test}`, {
      referenceFiles: ["src/fix.ts"],
      referenceDiffLines: 10,
    });

    expect(result.testOnlyPatch).toContain("test/fix.test.ts");
    expect(result.testOnlyPatch).not.toContain("src/fix.ts");
  });
});

import { describe, expect, it } from "vitest";
import { buildChangeDocument } from "../src/change-document.js";
import { inspectPatchSafety } from "../src/patch-safety.js";

const limits = { maxFiles: 4, maxBytes: 20_000 } as const;

function patch(path: string, body = "+const value = 1;\n"): string {
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -0,0 +1 @@\n${body}`;
}

function quotedPatch(left: string, right: string): string {
  return `diff --git "a/${left}" "b/${right}"\n--- "a/${left}"\n+++ "b/${right}"\n@@ -1 +1 @@\n-old\n+new\n`;
}

describe("B2 patch safety", () => {
  it("accepts a normal patch and flags dependency/lockfile review items", () => {
    const result = inspectPatchSafety(`${patch("src/a.ts")}\n${patch("package.json", "+{\"dependencies\":{}}\n")}\n${patch("pnpm-lock.yaml")}`, limits);
    expect(result.files).toEqual(["src/a.ts", "package.json", "pnpm-lock.yaml"]);
    expect(result.dependencyChanged).toBe(true);
    expect(result.lockfileChanged).toBe(true);
    expect(result.secretFindings).toEqual([]);
  });

  it("parses quoted diff paths and paths containing spaces", () => {
    const result = inspectPatchSafety(quotedPatch("src/old name.ts", "src/new name.ts"), limits);
    expect(result.files).toEqual(["src/old name.ts", "src/new name.ts"]);
  });

  it("allows renames but applies blocked-path checks to both sides", () => {
    expect(inspectPatchSafety(quotedPatch("src/old name.ts", "src/new name.ts"), limits).files).toEqual(["src/old name.ts", "src/new name.ts"]);
    expect(() => inspectPatchSafety(quotedPatch("src/old.ts", ".github/workflows/release job.yml"), limits)).toThrow(/CI configuration/i);
    expect(() => inspectPatchSafety(quotedPatch(".github/workflows/old job.yml", "src/new.ts"), limits)).toThrow(/CI configuration/i);
  });

  it("fails closed when a diff header cannot be parsed or normalized", () => {
    const malformed = `diff --git a/src/good.ts b/src/good.ts\n--- a/src/good.ts\n+++ b/src/good.ts\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/src/bad name.ts b/src/bad name.ts\n`;
    expect(() => inspectPatchSafety(malformed, limits)).toThrow(/parse|header/i);
    expect(() => inspectPatchSafety(quotedPatch("../escape.ts", "src/safe.ts"), limits)).toThrow(/root/i);
  });

  it.each([
    ["path traversal", patch("../escape.ts")],
    ["workflow", patch(".github/workflows/ci.yml")],
    ["configured CI", patch("ci/release.yml")],
  ])("rejects %s paths", (_name, value) => {
    expect(() => inspectPatchSafety(value, { ...limits, blockedCiPaths: ["ci/"] })).toThrow();
  });

  it("rejects symlinks and file/byte caps", () => {
    expect(() => inspectPatchSafety(`diff --git a/link b/link\nnew file mode 120000\n--- /dev/null\n+++ b/link\n@@ -0,0 +1 @@\n+target\n`, limits)).toThrow(/symlink/i);
    expect(() => inspectPatchSafety(`${patch("a")}\n${patch("b")}\n${patch("c")}\n${patch("d")}\n${patch("e")}`, limits)).toThrow(/files/i);
    expect(() => inspectPatchSafety(patch("a", `+${"x".repeat(200)}\n`), { maxFiles: 2, maxBytes: 50 })).toThrow(/bytes/i);
  });

  it("blocks secrets only when they are added, allowing a leaked key to be removed", () => {
    expect(() => inspectPatchSafety(patch("src/config.ts", "+const token = \"ghp_abcdefghijklmnopqrstuvwxyz1234567890\";\n"), limits)).toThrow(/secret/i);
    expect(() => inspectPatchSafety(patch("key.pem", "+-----BEGIN PRIVATE KEY-----\n+abc\n"), limits)).toThrow(/secret/i);
    const removed = patch("src/config.ts", "-const token = \"ghp_abcdefghijklmnopqrstuvwxyz1234567890\";\n+const token = process.env.GITHUB_TOKEN;\n");
    expect(inspectPatchSafety(removed, limits).secretFindings).toEqual([]);
  });
});

describe("B2 change document", () => {
  it("contains the required review fields while redacting email and credential-like values", () => {
    const document = buildChangeDocument({
      asked: "Fix retry for alice@example.com",
      changed: "Updated retry guard; token ghp_abcdefghijklmnopqrstuvwxyz1234567890 was not included",
      files: ["src/retry.ts", "src/retry.test.ts"],
      checks: [{ name: "test", status: "passed" }],
      reproduceProof: "failed on approved source; passed on patched source",
      costUsd: 0.42,
      reviewFocus: "Review retry state transition",
    });
    expect(document).toContain("What was asked");
    expect(document).toContain("What changed and why");
    expect(document).toContain("Files touched");
    expect(document).toContain("Checks and results");
    expect(document).toContain("Reproduce proof");
    expect(document).toContain("$0.42");
    expect(document).toContain("Developer review focus");
    expect(document).not.toContain("alice@example.com");
    expect(document).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz1234567890");
  });

  it("renders unavailable cost without inventing zero spend", () => {
    const document = buildChangeDocument({
      asked: "Fix retry",
      changed: "Updated retry guard",
      files: ["src/retry.ts"],
      checks: [{ name: "test", status: "pre_existing_unverified" }],
      reproduceProof: "not reproduced",
      costUsd: null,
      reviewFocus: "Review failure evidence",
    });
    expect(document).toContain("Cost unavailable");
    expect(document).not.toContain("$0.00");
    expect(document).toContain("pre_existing_unverified");
  });
});

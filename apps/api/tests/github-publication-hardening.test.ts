import { describe, expect, it } from "vitest";
import { protectedPublicationPaths } from "../src/github-publication.js";

const patch = "diff --git a/src/retry.ts b/src/retry.ts\n--- a/src/retry.ts\n+++ b/src/retry.ts\n@@ -1 +1 @@\n-old\n+new\n";

describe("GitHub publication protected-path hardening", () => {
  it("ignores root tokens whose extension is not a known repository source/config extension", () => {
    const result = protectedPublicationPaths("Update version.1 and package.json plus src/retry.ts", patch);
    expect(result).toEqual(["package.json", "src/retry.ts"]);
  });

  it("rejects more than 200 protected paths with a clear error", () => {
    const plan = Array.from({ length: 201 }, (_, index) => `\`src/file-${index}.ts\``).join(" ");
    expect(() => protectedPublicationPaths(plan, patch)).toThrow(/200|protected.*path|narrower/i);
  });
});

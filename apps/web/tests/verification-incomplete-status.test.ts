import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("verification incomplete UI", () => {
  it("renders verification_incomplete as a clear non-success state", async () => {
    const source = await readFile("apps/web/components/task-execution-status.tsx", "utf8");
    expect(source).toContain("verification_incomplete");
    expect(source).toContain("Verification incomplete");
    expect(source).toContain("not marked successful");
  });
});

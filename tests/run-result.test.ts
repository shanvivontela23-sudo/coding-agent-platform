import { describe, expect, it } from "vitest";
import { runResultSchema } from "../src/domain/run-result.js";

describe("runResultSchema", () => {
  it("rejects an invalid fourth run", () => {
    const result = runResultSchema.safeParse({
      runId: "r1",
      taskId: "t1",
      stack: "typescript-node",
      difficulty: "easy",
      split: "development",
      runNumber: 4,
    });
    expect(result.success).toBe(false);
  });
});

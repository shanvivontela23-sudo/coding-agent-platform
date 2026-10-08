import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Product 07 additive migration contract", () => {
  it("adds upload versions, source-aware reports, estimate ranges, and clarification filter metrics without editing 0004", async () => {
    const migration = await readFile("packages/db/migrations/0005_zip_projects_and_task_review_fixes.sql", "utf8");
    for (const fragment of [
      "CREATE TABLE project_versions",
      "analysed_version_id",
      "estimated_cost_usd_min",
      "estimated_cost_usd_max",
      "estimated_time_minutes_min",
      "estimated_time_minutes_max",
      "clarification_filtered_count",
      "clarification_rephrased_count",
    ]) expect(migration).toContain(fragment);
    const frozen = await readFile("packages/db/migrations/0004_task_intake.sql", "utf8");
    expect(frozen).toContain("estimated_cost_usd numeric(14,8)");
    expect(frozen).toContain("estimated_time_minutes integer");
  });
});

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("stack skill execution profile migration contract", () => {
  it("adds only nullable skill metadata through a new 0013 migration", async () => {
    const migration = await readFile("packages/db/migrations/0013_stack_skill_execution_profile.sql", "utf8");
    for (const column of ["planning_skill_id", "planning_skill_version", "execution_profile", "implementation_skill_id", "implementation_skill_version", "sandbox_template_id"]) {
      expect(migration).toContain(`ADD COLUMN ${column}`);
    }
    expect(migration).not.toMatch(/NOT NULL\s+DEFAULT|SET NOT NULL/);
    expect(migration).not.toMatch(/\bGRANT\b|\bREVOKE\b|\bPOLICY\b|ROW LEVEL SECURITY/);
    expect(migration).toContain("jsonb_typeof(execution_profile) = 'object'");
  });
});

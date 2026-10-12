import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("verification incomplete migration contract", () => {
  it("adds verification_incomplete through a new 0008 migration without editing applied migrations", async () => {
    const migration = await readFile("packages/db/migrations/0008_verification_incomplete.sql", "utf8");
    expect(migration).toContain("verification_incomplete");
    expect(migration).toContain("CREATE OR REPLACE FUNCTION public.finish_task_execution");
    expect(migration).toContain("GRANT EXECUTE ON FUNCTION public.finish_task_execution");
  });
});

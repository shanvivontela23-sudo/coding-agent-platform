import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { loadMigrationPlan, migrationMarkers, migrationPlanFromEntries, migrationsToApply } from "../src/migrations.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

describe("demo migration planning", () => {
  it("keeps numbered migrations in lexical order and refuses a checksum mismatch", () => {
    const entries = [
      { name: "0011_last.sql", contents: "last", expectedSha256: digest("last") },
      { name: "0009_first.sql", contents: "first", expectedSha256: digest("first") },
      { name: "0010_middle.sql", contents: "middle", expectedSha256: digest("middle") },
    ];
    expect(migrationPlanFromEntries(entries).map((entry) => entry.name)).toEqual(["0009_first.sql", "0010_middle.sql", "0011_last.sql"]);
    expect(() => migrationPlanFromEntries([{ name: "0011_last.sql", contents: "changed", expectedSha256: digest("last") }])).toThrow(/checksum/i);
  });

  it("refuses duplicate or non-numbered migration entries", () => {
    const sha = digest("x");
    expect(() => migrationPlanFromEntries([{ name: "0011_x.sql", contents: "x", expectedSha256: sha }, { name: "0011_x.sql", contents: "x", expectedSha256: sha }])).toThrow(/duplicate/i);
    expect(() => migrationPlanFromEntries([{ name: "readme.sql", contents: "x", expectedSha256: sha }])).toThrow(/numbered/i);
  });
});

describe("demo migration catch-up", () => {
  const entry = (name: string) => ({ name, contents: name, expectedSha256: digest(name) });
  const plan = migrationPlanFromEntries(["0001_core.sql", "0012_task_planning_attempt.sql", "0013_stack_skill_execution_profile.sql"].map(entry));

  it("applies everything to an empty database and nothing to an up-to-date one", () => {
    expect(migrationsToApply(plan, false, new Set()).map((item) => item.name)).toHaveLength(3);
    expect(migrationsToApply(plan, true, new Set(migrationMarkers.map((marker) => marker.name)))).toEqual([]);
  });

  it("applies only 0013 to a database that stops at 0012", () => {
    expect(migrationsToApply(plan, true, new Set(["0012_task_planning_attempt.sql"])).map((item) => item.name)).toEqual(["0013_stack_skill_execution_profile.sql"]);
  });

  it("refuses a database older than the first marker or with a gap", () => {
    expect(() => migrationsToApply(plan, true, new Set())).toThrow(/partially migrated/);
    expect(() => migrationsToApply(plan, true, new Set(["0013_stack_skill_execution_profile.sql"]))).toThrow(/partially migrated/);
  });

  it("requires the newest committed migration to have a marker", async () => {
    const committed = await loadMigrationPlan();
    expect(migrationMarkers.map((marker) => marker.name)).toContain(committed.at(-1)?.name);
    expect(() => migrationsToApply([...plan, entry("0099_unmarked.sql")], true, new Set())).toThrow(/no applied-schema marker/);
  });
});

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { migrationPlanFromEntries } from "../src/migrations.js";

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

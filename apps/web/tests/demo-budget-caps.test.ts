import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("demo budget cap UI", () => {
  it("shows planning and implementation caps before Start implementation", async () => {
    const source = await readFile("apps/web/components/task-execution-status.tsx", "utf8");
    expect(source).toContain("Planning cap");
    expect(source).toContain("Implementation cap");
    expect(source).toContain("demoBudgetCaps");
    expect(source.indexOf("Planning cap")).toBeLessThan(source.indexOf("Start implementation"));
  });
});

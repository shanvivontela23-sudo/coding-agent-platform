import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("home GitHub resilience UI", () => {
  it("renders an unknown GitHub state quietly without hiding projects", async () => {
    const home = await readFile("apps/web/app/home/page.tsx", "utf8");
    expect(home).toContain('status: "unknown"');
    expect(home).toContain("Could not check GitHub right now");
    expect(home).toContain("Add a repository");
  });
});

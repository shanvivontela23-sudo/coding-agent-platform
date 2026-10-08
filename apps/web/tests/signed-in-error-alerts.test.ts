import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const pages = [
  "apps/web/app/home/page.tsx",
  "apps/web/app/members/page.tsx",
  "apps/web/app/github/repositories/page.tsx",
  "apps/web/app/projects/[projectId]/page.tsx",
  "apps/web/app/projects/[projectId]/tasks/new/page.tsx",
  "apps/web/app/tasks/[taskId]/page.tsx",
] as const;

describe("signed-in error query visibility", () => {
  it.each(pages)("renders ?error= as a visible destructive alert on %s", async (path) => {
    const source = await readFile(path, "utf8");
    expect(source).toContain("searchParams");
    expect(source).toMatch(/params\.error|\{ error \}/);
    expect(source).toContain("Alert");
    expect(source).toContain('variant="destructive"');
    expect(source).toContain("AlertDescription");
  });
});

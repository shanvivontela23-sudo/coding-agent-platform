import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("project learning panel", () => {
  it("loads bounded project decisions and renders readable evidence with task links", async () => {
    const page = await readFile("apps/web/app/projects/[projectId]/page.tsx", "utf8");
    const panel = await readFile("apps/web/components/project-decisions.tsx", "utf8");
    expect(page).toContain("/decisions");
    expect(page).toContain("ProjectDecisions");
    expect(panel).toContain("What Dhara learned");
    expect(panel).toContain("No project learning yet.");
    expect(panel).toContain('href={`/tasks/${decision.taskId}`}');
    expect(panel).toContain("decision.summary");
  });

  it("shows the mark-as-wrong action only to owners", async () => {
    const panel = await readFile("apps/web/components/project-decisions.tsx", "utf8");
    expect(panel).toContain('currentUserRole === "owner"');
    expect(panel).toContain("Mark as wrong");
    expect(panel).toContain("/supersede");
  });
});

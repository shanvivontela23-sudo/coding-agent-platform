import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { canApprovePlan } from "../src/task-permissions.js";

describe("plan approval visibility", () => {
  const requester = "user-1";

  it("lets the requester approve a ready plan regardless of role (owner created the demo task)", () => {
    expect(canApprovePlan({ status: "plan_ready", requestedByUserId: requester }, requester)).toBe(true);
  });

  it("hides approval from anyone other than the requester", () => {
    expect(canApprovePlan({ status: "plan_ready", requestedByUserId: requester }, "user-2")).toBe(false);
  });

  it.each(["draft", "waiting_for_answers", "approved"])("hides approval when status is %s", (status) => {
    expect(canApprovePlan({ status, requestedByUserId: requester }, requester)).toBe(false);
  });

  it("task page uses the shared rule instead of a rep-only role check", async () => {
    const page = await readFile("apps/web/app/tasks/[taskId]/page.tsx", "utf8");
    expect(page).toContain("canApprovePlan(task, home.user.id)");
    expect(page).not.toContain('currentUserRole === "rep"');
  });
});

describe("project report install command", () => {
  it("shows the stored install command with a hint for reports that predate it", async () => {
    const page = await readFile("apps/web/app/projects/[projectId]/page.tsx", "utf8");
    expect(page).toContain('title="Install command"');
    expect(page).toContain("project.report.installCommand");
    expect(page).toContain("Re-analyse to detect");
  });
});

describe("draft task message", () => {
  it("says a draft task failed and offers the requester an in-place retry", async () => {
    const page = await readFile("apps/web/app/tasks/[taskId]/page.tsx", "utf8");
    expect(page).not.toContain("Clarification has not completed yet.");
    expect(page).toContain("draftTaskMessage");
    expect(page).toContain("/retry-clarification");
    expect(page).toContain("Try again");
  });
});

describe("project current version after promotion", () => {
  it("flags when the analysis is for an older version than the current one", async () => {
    const page = await readFile("apps/web/app/projects/[projectId]/page.tsx", "utf8");
    expect(page).toContain("analysedVersionNumber");
    expect(page).toContain("Re-analyse to refresh it.");
  });

  it("API reports the latest version as current, not the analysed one", async () => {
    const db = await readFile("apps/api/src/upload-project-database.ts", "utf8");
    expect(db).toContain("ORDER BY version_number DESC LIMIT 1) pv ON true");
    expect(db).toContain("apv.version_number AS analysed_version_number");
  });
});

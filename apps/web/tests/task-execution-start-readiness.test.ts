import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("task implementation readiness", () => {
  it("shows the legacy-report blocker and does not offer Start while blocked", async () => {
    const page = await readFile("apps/web/app/tasks/[taskId]/page.tsx", "utf8");
    const execution = await readFile("apps/web/components/task-execution-status.tsx", "utf8");
    expect(page).toContain("implementationBlocker");
    expect(execution).toContain("Re-analyse this project before implementation");
    expect(execution).toContain("implementationBlocker");
  });
});

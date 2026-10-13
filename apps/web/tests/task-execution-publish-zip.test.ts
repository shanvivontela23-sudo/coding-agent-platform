import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

// Live run 2026-10-13: "Publish pull request" showed on a ZIP-backed task.
// The API already refuses ("Only GitHub implementation results can be
// published"), so the button must not be offered.
describe("publish button visibility", () => {
  it("is only offered for GitHub-backed runs (no sourceVersionId)", async () => {
    const component = await readFile("apps/web/components/task-execution-status.tsx", "utf8");
    expect(component).toContain('&& !execution?.sourceVersionId;');
    expect(component).toMatch(/const publishable = \(execution\?\.status === "succeeded" \|\| execution\?\.status === "fix_not_reproduced"\) && !execution\?\.sourceVersionId;/);
  });
});

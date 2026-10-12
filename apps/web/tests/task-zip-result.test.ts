import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function source(path: string): Promise<string> { return await readFile(path, "utf8"); }

describe("B4 ZIP result UI", () => {
  it("renders collapsible per-file diff sections with line counts and a full-patch download for truncation", async () => {
    const component = await source("apps/web/components/task-execution-status.tsx");
    expect(component).toContain("<details");
    expect(component).toContain("added");
    expect(component).toContain("removed");
    expect(component).toContain("Download full patch");
    expect(component).toContain("DIFF_LINE_LIMIT");
  });

  it("offers result download, approved-source download, explicit unproven acceptance, and developer/owner promotion", async () => {
    const component = await source("apps/web/components/task-execution-status.tsx");
    expect(component).toContain("Download updated ZIP");
    expect(component).toContain("Download approved source ZIP");
    expect(component).toContain("Accept unproven ZIP result");
    expect(component).toContain("Promote to current version");
    expect(component).toContain("source_changed");
  });
});

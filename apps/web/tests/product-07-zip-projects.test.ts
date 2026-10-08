import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Product 07 ZIP project experience", () => {
  it("offers GitHub and ZIP project creation", async () => {
    const home = await readFile("apps/web/app/home/page.tsx", "utf8");
    expect(home).toContain("Connect a repository");
    expect(home).toContain("Upload ZIP");
    expect(home).toContain("/projects/upload");
    expect(home).toContain('encType="multipart/form-data"');
  });

  it("shows source/current version, Re-analyse, download, and upload-owner deletion controls", async () => {
    const page = await readFile("apps/web/app/projects/[projectId]/page.tsx", "utf8");
    for (const value of ["Source", "Current version", "Re-analyse", "/reanalyse", "Download", "/download-token", "Delete project"]) expect(page).toContain(value);
    expect(page).toContain("project.source.type");
  });

  it("shows server-derived cost/time ranges explicitly labelled as estimates", async () => {
    const page = await readFile("apps/web/app/tasks/[taskId]/page.tsx", "utf8");
    expect(page).toContain("Estimated cost");
    expect(page).toContain("Estimated time");
    expect(page).toContain("costUsdMin");
    expect(page).toContain("costUsdMax");
    expect(page).toContain("timeMinutesMin");
    expect(page).toContain("timeMinutesMax");
    expect(page).toContain("Estimate");
  });
});

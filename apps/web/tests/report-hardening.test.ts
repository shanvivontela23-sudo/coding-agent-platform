import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

async function pageFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await pageFiles(path));
    else if (entry.name === "page.tsx") files.push(path);
  }
  return files;
}

describe("Product 05 report hardening UI", () => {
  it("centralizes signed-in heading sizes in shared primitives", async () => {
    const heading = await readFile("apps/web/components/ui/heading.tsx", "utf8");
    expect(heading).toContain("PageTitle");
    expect(heading).toContain("SectionTitle");
    expect(heading).toContain("text-2xl");
    expect(heading).toContain("text-lg");

    for (const path of await pageFiles("apps/web/app")) {
      const source = await readFile(path, "utf8");
      if (!source.includes("<AppShell")) continue;
      expect(source, path).toContain("PageTitle");
      expect(source, path).not.toMatch(/<h1[^>]*className=/);
      expect(source, path).not.toMatch(/<h2[^>]*className=/);
      expect(source, path).not.toMatch(/text-(?:3xl|4xl|5xl|6xl|7xl|8xl|9xl)/);
    }
  });

  it("keeps card titles at the shared card-title size", async () => {
    const card = await readFile("apps/web/components/ui/card.tsx", "utf8");
    expect(card).toContain("text-base");
    expect(card).toContain("font-medium");

    const project = await readFile("apps/web/app/projects/[projectId]/page.tsx", "utf8");
    expect(project).not.toMatch(/CardTitle className=/);
  });

  it("uses the approved project-report copy and a seven-character GitHub commit link", async () => {
    const project = await readFile("apps/web/app/projects/[projectId]/page.tsx", "utf8");
    expect(project).toContain("What Dhara found");
    expect(project).not.toContain("Deterministic analysis");
    expect(project).toContain("slice(0, 7)");
    expect(project).toContain("https://github.com/");
    expect(project).toContain("/commit/");
  });

  it("uses the approved repository-picker subtitle", async () => {
    const picker = await readFile("apps/web/app/github/repositories/page.tsx", "utf8");
    expect(picker).toContain("Choose a repository for Dhara to learn.");
    expect(picker).not.toContain("Choose one repository for Dhara to analyse deterministically.");
  });

  it("renders workspace commands when present while remaining compatible with older stored reports", async () => {
    const project = await readFile("apps/web/app/projects/[projectId]/page.tsx", "utf8");
    expect(project).toContain("workspaceCommands");
    expect(project).toContain("workspaceCommands ?? []");
    expect(project).toContain("workspace.path");
    expect(project).toContain("workspace.name");
  });
});

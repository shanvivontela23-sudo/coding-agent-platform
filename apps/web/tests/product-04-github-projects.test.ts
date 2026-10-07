import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const signedInPages = [
  "apps/web/app/home/page.tsx",
  "apps/web/app/members/page.tsx",
  "apps/web/app/connect/github/page.tsx",
  "apps/web/app/projects/[id]/page.tsx",
] as const;

describe("Product 04 signed-in GitHub project flow", () => {
  it("makes Connect a repository a live primary action and renders project links", async () => {
    const home = await readFile("apps/web/app/home/page.tsx", "utf8");
    expect(home).toContain("/github/install/start");
    expect(home).toContain("buttonVariants");
    expect(home).not.toMatch(/<Button[^>]*\sdisabled(?:\s|>|=)/);
    expect(home).not.toMatch(/<button[^>]*\sdisabled(?:\s|>|=)/i);
    expect(home).toContain("/projects/");
  });

  it("uses only live navigation with active accent tint and inactive secondary text", async () => {
    const shell = await readFile("apps/web/components/app-shell.tsx", "utf8");
    const navigation = await readFile("apps/web/components/app-navigation.tsx", "utf8");
    expect(shell).toContain("AppNavigation");
    expect(shell).not.toContain("Tasks");
    expect(shell).not.toContain("Settings");
    expect(shell).not.toContain("futureNavigation");
    expect(navigation).toContain("usePathname");
    expect(navigation).toContain('href: "/home"');
    expect(navigation).toContain('href: "/members"');
    expect(navigation).toContain("bg-accent-tint");
    expect(navigation).toContain("text-accent");
    expect(navigation).toContain("text-muted-foreground");
    expect(navigation).toContain("/connect/github");
    expect(navigation).toContain("/projects/");
  });

  it("uses card-title typography for How it works and keeps signed-in headings within the page-title ceiling", async () => {
    const home = await readFile("apps/web/app/home/page.tsx", "utf8");
    expect(home).toContain('<CardTitle className="text-base font-medium">{step.title}</CardTitle>');
    for (const path of signedInPages) {
      const source = await readFile(path, "utf8");
      expect(source, path).not.toMatch(/text-(?:3xl|4xl|5xl|6xl|7xl|8xl|9xl)/);
    }
  });

  it("renders a repository picker that submits only the selected repository id", async () => {
    const page = await readFile("apps/web/app/connect/github/page.tsx", "utf8");
    expect(page).toContain("/api/github/repositories");
    expect(page).toContain('action={`${apiOrigin}/projects`}');
    expect(page).toContain('name="repositoryId"');
    expect(page).toContain("Connect repository");
    expect(page).toContain("defaultBranch");
  });

  it("renders the persisted deterministic project report", async () => {
    const page = await readFile("apps/web/app/projects/[id]/page.tsx", "utf8");
    expect(page).toContain("/api/projects/");
    for (const label of [
      "Repository",
      "Default branch",
      "Last analysed commit",
      "Languages",
      "Frameworks",
      "Package manager",
      "Build command",
      "Test command",
      "Stack skill",
    ]) expect(page).toContain(label);
    expect(page).toContain("lastAnalyzedCommitSha");
    expect(page).toContain("report.languages");
    expect(page).toContain("report.frameworks");
  });
});

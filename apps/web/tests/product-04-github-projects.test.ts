import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Product 04 signed-in web flow", () => {
  it("keeps signed-in navigation limited to existing pages and styles the active page", async () => {
    const shell = await readFile("apps/web/components/app-shell.tsx", "utf8");
    expect(shell).toContain("Projects");
    expect(shell).toContain("Tasks");
    expect(shell).toContain("Members");
    expect(shell).not.toContain("Settings");
    expect(shell).toContain("activePath");
    expect(shell).toContain("bg-accent-tint");
    expect(shell).toContain("text-muted-foreground");
    expect(shell).toContain("aria-current");
  });

  it("routes an active GitHub connection to Dhara's picker and exposes account management", async () => {
    const home = await readFile("apps/web/app/home/page.tsx", "utf8");
    expect(home).toContain("Connect a repository");
    expect(home).toContain("/github/connect/start");
    expect(home).toContain("Add a repository");
    expect(home).toContain('href="/github/repositories"');
    expect(home).toContain("Connected to GitHub as");
    expect(home).toContain("Manage access");
    expect(home).toContain('target="_blank"');
    expect(home).not.toMatch(/<Button[^>]*disabled/);
    expect(home).toContain('activePath="/home"');
  });

  it("shows project source details on home cards", async () => {
    const home = await readFile("apps/web/app/home/page.tsx", "utf8");
    expect(home).toContain("project.source.fullName");
    expect(home).toContain("Default branch:");
    expect(home).toContain("project.source.defaultBranch");
    expect(home).toContain("ZIP upload · Version");
    expect(home).toContain("project.source.versionNumber");
  });

  it("uses medium card-title sizing for How it works and keeps signed-in headings within the page-title scale", async () => {
    const home = await readFile("apps/web/app/home/page.tsx", "utf8");
    expect(home).toContain('CardTitle className="text-base font-medium"');
    expect(home).not.toMatch(/text-(?:3xl|4xl|5xl|6xl|7xl|8xl|9xl)/);
  });

  it("makes the repository picker refreshable and links repositories that are already projects", async () => {
    const picker = await readFile("apps/web/app/github/repositories/page.tsx", "utf8");
    expect(picker).toContain("Select a repository");
    expect(picker).toContain("Waiting for your GitHub admin to approve.");
    expect(picker).toContain("/api/github/repositories");
    expect(picker).toContain("/github/projects");
    expect(picker).toContain("Refresh");
    expect(picker).toContain("Already a project");
    expect(picker).toContain("Open project");
    expect(picker).toContain("repository.projectId");
    expect(picker).toContain('activePath="/home"');
  });

  it("adds a project report page with reconnect behavior", async () => {
    const page = await readFile("apps/web/app/projects/[projectId]/page.tsx", "utf8");
    for (const text of ["Default branch", "Last analysed commit", "Languages", "Frameworks", "Package manager", "Build command", "Test command", "Stack skill"]) {
      expect(page).toContain(text);
    }
    expect(page).toContain("Reconnect GitHub");
    expect(page).toContain("/github/connect/start");
    expect(page).toContain("/api/projects/");
    expect(page).toContain('activePath="/home"');
  });
});
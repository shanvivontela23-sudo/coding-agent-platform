import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Product 04 signed-in web flow", () => {
  it("makes Connect a repository live and keeps How it works card titles at medium card-title scale", async () => {
    const home = await readFile("apps/web/app/home/page.tsx", "utf8");
    expect(home).toContain("/github/install/start"); expect(home).not.toMatch(/<Button[^>]*disabled/); expect(home).toContain('className="text-base font-medium"');
  });
  it("shows only existing navigation and active-route styling", async () => {
    const shell = await readFile("apps/web/components/app-shell.tsx", "utf8");
    expect(shell).toContain("Projects"); expect(shell).toContain("Members"); expect(shell).not.toContain("Tasks"); expect(shell).not.toContain("Settings"); expect(shell).toContain("bg-accent-tint"); expect(shell).toContain("text-muted-foreground");
  });
  it("adds repository picker and deterministic project report page with reconnect state", async () => {
    const connect = await readFile("apps/web/app/connect/page.tsx", "utf8");
    const project = await readFile("apps/web/app/projects/[id]/page.tsx", "utf8");
    expect(connect).toContain("Choose a repository"); expect(connect).toContain("/github/projects"); expect(project).toContain("Last analysed commit"); expect(project).toContain("Default branch"); expect(project).toContain("Reconnect GitHub"); expect(project).toContain("Languages"); expect(project).toContain("Frameworks");
  });
});

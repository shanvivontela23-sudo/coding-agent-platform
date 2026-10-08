import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Dhara signed-in web flow", () => {
  it("renders first-run organization creation", async () => {
    const page = await readFile("apps/web/app/onboarding/page.tsx", "utf8");
    expect(page).toContain("PRODUCT_NAME");
    expect(page).toContain("Create your organization");
    expect(page).toContain('name="organizationName"');
    expect(page).toContain("/onboarding/organization");
    expect(page).toContain("searchParams");
    expect(page).toContain("error");
  });

  it("renders organization, signed-in email and projects through the shared app shell", async () => {
    const page = await readFile("apps/web/app/home/page.tsx", "utf8");
    const shell = await readFile("apps/web/components/app-shell.tsx", "utf8");
    expect(page).toContain("AppShell");
    expect(page).toContain("/api/home");
    expect(page).toContain("organization.name");
    expect(page).toContain("user.email");
    expect(page).toContain("No projects yet. Connect a repository or upload a ZIP to get started.");
    expect(shell).toContain("PRODUCT_NAME");
    expect(shell).toContain("userEmail");
  });
});

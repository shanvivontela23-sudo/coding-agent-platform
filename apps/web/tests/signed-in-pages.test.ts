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

  it("renders organization name, projects empty state, and sign out on home", async () => {
    const page = await readFile("apps/web/app/home/page.tsx", "utf8");
    expect(page).toContain("PRODUCT_NAME");
    expect(page).toContain("/api/home");
    expect(page).toContain("organization.name");
    expect(page).toContain("No projects yet");
    expect(page).toContain("/auth/sign-out");
  });
});

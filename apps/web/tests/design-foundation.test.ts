import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

type WebPackage = {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
};

async function tsxFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await tsxFiles(path));
    else if (entry.name.endsWith(".tsx")) files.push(path);
  }
  return files;
}

describe("Dhara web design foundation", () => {
  it("uses Tailwind and shadcn-style UI primitives", async () => {
    const pkg = JSON.parse(await readFile("apps/web/package.json", "utf8")) as WebPackage;
    expect(pkg.devDependencies?.tailwindcss).toBeTruthy();
    expect(pkg.devDependencies?.["@tailwindcss/postcss"]).toBeTruthy();
    expect(pkg.dependencies?.["class-variance-authority"]).toBeTruthy();
    expect(pkg.dependencies?.clsx).toBeTruthy();
    expect(pkg.dependencies?.["tailwind-merge"]).toBeTruthy();

    for (const component of ["button", "card", "input", "alert"]) {
      const source = await readFile(`apps/web/components/ui/${component}.tsx`, "utf8");
      expect(source).toContain("className");
    }
    const postcss = await readFile("apps/web/postcss.config.mjs", "utf8");
    expect(postcss).toContain("@tailwindcss/postcss");
  });

  it("defines light and dark design tokens with one accent and a consistent type scale", async () => {
    const css = await readFile("apps/web/app/globals.css", "utf8");
    expect(css).toContain('@import "tailwindcss"');
    expect(css).toContain("--accent:");
    expect(css).toContain("--accent-foreground:");
    expect(css).toContain("prefers-color-scheme: dark");
    expect(css).toContain("--text-display:");
    expect(css).toContain("--text-heading:");
    expect(css).toContain("--text-body:");
    expect(css).toContain("--text-caption:");
  });

  it("removes hand-written inline styles from the app and shared components", async () => {
    const roots = ["apps/web/app", "apps/web/components"];
    for (const root of roots) {
      for (const path of await tsxFiles(root)) {
        const source = await readFile(path, "utf8");
        expect(source, path).not.toContain("style={{");
      }
    }
  });

  it("provides the signed-in app shell and responsive navigation", async () => {
    const shell = await readFile("apps/web/components/app-shell.tsx", "utf8");
    expect(shell).toContain("PRODUCT_NAME");
    for (const label of ["Projects", "Tasks", "Members", "Settings"]) {
      expect(shell).toContain(label);
    }
    expect(shell).toContain("organizationName");
    expect(shell).toContain("userEmail");
    expect(shell).toContain("UserMenu");
    expect(shell).toMatch(/md:/);
    expect(shell).not.toContain("Workspace");
    expect(shell).not.toContain("User menu");
  });

  it("uses centered card layouts for login and onboarding with readable errors", async () => {
    const login = await readFile("apps/web/app/page.tsx", "utf8");
    const onboarding = await readFile("apps/web/app/onboarding/page.tsx", "utf8");
    for (const source of [login, onboarding]) {
      expect(source).toContain("Card");
      expect(source).toContain("Alert");
      expect(source).toContain("PRODUCT_NAME");
    }
    expect(login).toContain("Turn support requests into reviewed pull requests.");
    expect(login).toContain("Input");
    expect(login).toContain("Button");
    expect(onboarding).toContain("Create your organization");
    expect(onboarding).toContain("Input");
    expect(onboarding).toContain("Button");
  });

  it("renders the signed-in home foundation without changing its API route", async () => {
    const home = await readFile("apps/web/app/home/page.tsx", "utf8");
    expect(home).toContain("AppShell");
    expect(home).toContain("Welcome to Dhara");
    expect(home).toContain("/api/home");
    expect(home).toContain("No projects yet. Connect a repository to get started.");
    expect(home).not.toContain("Coming soon");
    expect(home).not.toContain("next product slice");
    expect(home).toContain("How it works");
    for (const step of ["Connect a repo", "Describe a change", "Review the pull request"]) {
      expect(home).toContain(step);
    }
  });
});

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Dhara signed-in polish and theme", () => {
  it("uses the approved semantic light and dark tokens", async () => {
    const css = await readFile("apps/web/app/globals.css", "utf8");
    for (const token of [
      "--page: #FAFAF7",
      "--card: #FFFFFF",
      "--sidebar: #F3F2EE",
      "--border: #E4E2DC",
      "--border-control: #8D8C88",
      "--text: #1F2328",
      "--secondary-text: #5B616B",
      "--accent: #0F766E",
      "--accent-hover: #0B5F59",
      "--accent-tint: #E6F4F1",
      "--success: #1A7E4A",
      "--warning: #B35209",
      "--danger: #B42318",
      "--accent-foreground: #FAFAF7",
      "--page: #14171A",
      "--card: #1C2024",
      "--sidebar: #171A1D",
      "--border: #2C3238",
      "--border-control: #666A6E",
      "--text: #E6E8EB",
      "--secondary-text: #A3AAB3",
      "--accent: #5EC4B6",
      "--accent-hover: #55AFA3",
      "--accent-tint: #17332F",
      "--success: #6CC495",
      "--warning: #E0A458",
      "--danger: #F0857A",
      "--accent-foreground: #0B1F1C",
    ]) {
      expect(css).toContain(token);
    }
    expect(css).toContain("font-size: 1rem");
    expect(css).toContain("line-height: 1.5");
    expect(css).toContain("--text-sm: 0.9375rem");
    expect(css).toContain("--text-sm--line-height: 1.40625rem");
  });

  it("uses control contrast for interactive borders and focus rings while keeping decorative borders subtle", async () => {
    const input = await readFile("apps/web/components/ui/input.tsx", "utf8");
    const button = await readFile("apps/web/components/ui/button.tsx", "utf8");
    expect(input).toContain("border-input");
    expect(input).toContain("ring-ring");
    expect(button).toContain("border-input");
    expect(button).toContain("ring-ring");
  });

  it("applies a saved System Light or Dark preference before paint", async () => {
    const layout = await readFile("apps/web/app/layout.tsx", "utf8");
    const menu = await readFile("apps/web/components/user-menu.tsx", "utf8");
    expect(layout).toContain("dhara-theme");
    expect(layout).toContain("data-theme");
    expect(menu).toContain("System");
    expect(menu).toContain("Light");
    expect(menu).toContain("Dark");
    expect(menu).toContain("localStorage");
  });

  it("shows email and initials in the user menu and Dhara plus organization in the sidebar", async () => {
    const shell = await readFile("apps/web/components/app-shell.tsx", "utf8");
    const menu = await readFile("apps/web/components/user-menu.tsx", "utf8");
    expect(shell).toContain("userEmail");
    expect(shell).toContain("organizationName");
    expect(shell).toContain("PRODUCT_NAME");
    expect(shell).toContain("UserMenu");
    expect(shell).not.toContain("Workspace");
    expect(menu).toContain("userEmail");
    expect(menu).toContain("initials");
    expect(menu).toContain("Sign out");
    expect(menu).not.toContain("User menu");
  });

  it("uses product copy and the shared compact signed-in heading scale", async () => {
    const home = await readFile("apps/web/app/home/page.tsx", "utf8");
    const heading = await readFile("apps/web/components/ui/heading.tsx", "utf8");
    expect(home).toContain("No projects yet. Connect a repository to get started.");
    expect(home).not.toContain("Coming soon");
    expect(home).not.toContain("next product slice");
    expect(home).toContain("PageTitle");
    expect(home).toContain("SectionTitle");
    expect(home).toContain("text-base");
    expect(heading).toContain("text-2xl");
    expect(heading).toContain("text-lg");
  });
});

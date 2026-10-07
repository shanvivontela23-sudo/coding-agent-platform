import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Dhara members and invite web flow", () => {
  it("adds a signed-in Members page with owner invite controls and labeled statuses", async () => {
    const page = await readFile("apps/web/app/members/page.tsx", "utf8");
    expect(page).toContain("AppShell");
    expect(page).toContain("/api/members");
    expect(page).toContain("Invite member");
    expect(page).toContain('name="email"');
    expect(page).toContain('name="role"');
    expect(page).toContain("Developer");
    expect(page).toContain("Support rep");
    expect(page).toContain("Pending");
    expect(page).toContain("text-2xl");
    expect(page).toContain("text-lg");
    expect(page).toContain("text-base");
  });

  it("shows explicit Accept, Decline and create-own choices to an invited first-time user", async () => {
    const page = await readFile("apps/web/app/invites/page.tsx", "utf8");
    expect(page).toContain("/api/invitations");
    expect(page).toContain("Accept");
    expect(page).toContain("Decline");
    expect(page).toContain("Create your own organization");
    expect(page).toContain("/invitations/accept");
    expect(page).toContain("/invitations/decline");
    expect(page).toContain("/onboarding");
    expect(page).toContain('variant="outline"');
  });

  it("links Members from the app shell without adding build-process wording", async () => {
    const shell = await readFile("apps/web/components/app-shell.tsx", "utf8");
    const home = await readFile("apps/web/app/home/page.tsx", "utf8");
    const members = await readFile("apps/web/app/members/page.tsx", "utf8");
    expect(shell).toContain('href: "/members"');
    expect(shell).toContain("href={item.href}");
    for (const source of [shell, home, members]) {
      expect(source).not.toMatch(/coming soon|next product slice|planned slice/i);
    }
  });
});

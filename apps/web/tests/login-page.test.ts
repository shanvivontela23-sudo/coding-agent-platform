import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

type WebPackage = { readonly scripts?: Readonly<Record<string, string>>; readonly dependencies?: Readonly<Record<string, string>> };

describe("Next.js login app", () => {
  it("declares the runtime dependencies and real Next scripts", async () => {
    const pkg = JSON.parse(await readFile("apps/web/package.json", "utf8")) as WebPackage;
    expect(pkg.scripts).toMatchObject({ dev: "next dev", build: "next build", start: "next start" });
    expect(pkg.dependencies?.next).toBe("16.4.0");
    expect(pkg.dependencies?.react).toBe("19.3.0");
    expect(pkg.dependencies?.["react-dom"]).toBe("19.3.0");
  });

  it("renders email sign-in for reps and an optional GitHub developer path through the API", async () => {
    const page = await readFile("apps/web/app/page.tsx", "utf8");
    expect(page).toContain("Sign in with email");
    expect(page).toContain('name="email"');
    expect(page).toContain('name="password"');
    expect(page).toContain("Continue with GitHub");
    expect(page).toContain("/auth/email");
    expect(page).toContain("/auth/github/start");
  });
});

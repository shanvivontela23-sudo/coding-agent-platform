import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

type WebPackage = { readonly scripts?: Readonly<Record<string, string>>; readonly dependencies?: Readonly<Record<string, string>> };

describe("Dhara login app", () => {
  it("declares the runtime dependencies and real Next scripts", async () => {
    const pkg = JSON.parse(await readFile("apps/web/package.json", "utf8")) as WebPackage;
    expect(pkg.scripts).toMatchObject({ dev: "next dev", build: "next build", start: "next start" });
    expect(pkg.dependencies?.next).toBe("16.4.0");
    expect(pkg.dependencies?.react).toBe("19.3.0");
    expect(pkg.dependencies?.["react-dom"]).toBe("19.3.0");
  });

  it("holds the working product name in one config constant used by page title and login", async () => {
    const config = await readFile("apps/web/src/product-config.ts", "utf8");
    const layout = await readFile("apps/web/app/layout.tsx", "utf8");
    const page = await readFile("apps/web/app/page.tsx", "utf8");
    expect(config).toContain('PRODUCT_NAME = "Dhara"');
    expect(layout).toContain("PRODUCT_NAME");
    expect(layout).toContain("title: PRODUCT_NAME");
    expect(page).toContain("PRODUCT_NAME");
    expect(page).not.toContain("Coding Agent Platform");
  });

  it("renders email sign-in, optional GitHub, and a readable error message from the redirect", async () => {
    const page = await readFile("apps/web/app/page.tsx", "utf8");
    expect(page).toContain("Sign in with email");
    expect(page).toContain('name="email"');
    expect(page).toContain('name="password"');
    expect(page).toContain("Continue with GitHub");
    expect(page).toContain("/auth/email");
    expect(page).toContain("/auth/github/start");
    expect(page).toContain("searchParams");
    expect(page).toContain("error");
  });
});

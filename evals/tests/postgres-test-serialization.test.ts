import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("PostgreSQL integration test scheduling", () => {
  it("runs database-mutating tests in a separate serial Vitest process", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      scripts?: Record<string, string>;
    };
    const scripts = packageJson.scripts ?? {};
    const parallelScript = scripts["test:parallel"] ?? "";
    const postgresScript = scripts["test:postgres"] ?? "";

    expect(scripts.test).toBe("pnpm test:parallel && pnpm test:postgres");
    expect(parallelScript).toContain("vitest run evals/tests apps packages");
    expect(parallelScript).toContain("--exclude 'packages/db/tests/**/*.test.ts'");

    const excludedGlobs = [...parallelScript.matchAll(/--exclude '([^']+)'/g)].map((match) => match[1]);
    const apiIntegrationGlob = excludedGlobs.find(
      (glob) => glob.startsWith("apps/api/tests/") && glob.endsWith(".integration.test.ts"),
    );
    expect(apiIntegrationGlob).toBeDefined();

    expect(postgresScript).toContain("vitest run --no-file-parallelism");
    expect(postgresScript).toContain("packages/db/tests");
    expect(postgresScript.split(/\s+/)).toContain(apiIntegrationGlob);
  });

  it("does not hide PostgreSQL races behind retries", async () => {
    const packageJson = await readFile("package.json", "utf8");
    expect(packageJson).not.toMatch(/\b(?:retry|rerun)\b/i);
  });
});

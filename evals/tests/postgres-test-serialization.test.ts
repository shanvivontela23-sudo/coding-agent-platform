import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const apiIntegrationTests = [
  "apps/api/tests/product-07-upload-http.integration.test.ts",
  "apps/api/tests/task-read-http.integration.test.ts",
  "apps/api/tests/tenant-api.integration.test.ts",
] as const;

describe("PostgreSQL integration test scheduling", () => {
  it("runs database-mutating tests in a separate serial Vitest process", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      scripts?: Record<string, string>;
    };
    const scripts = packageJson.scripts ?? {};

    expect(scripts.test).toBe("pnpm test:parallel && pnpm test:postgres");
    expect(scripts["test:parallel"]).toContain("vitest run evals/tests apps packages");
    expect(scripts["test:parallel"]).toContain("--exclude 'packages/db/tests/**/*.test.ts'");
    expect(scripts["test:parallel"]).toContain("--exclude 'apps/api/tests/*.integration.test.ts'");

    expect(scripts["test:postgres"]).toContain("vitest run --no-file-parallelism");
    expect(scripts["test:postgres"]).toContain("packages/db/tests");
    for (const path of apiIntegrationTests) expect(scripts["test:postgres"]).toContain(path);
  });

  it("does not hide PostgreSQL races behind retries", async () => {
    const packageJson = await readFile("package.json", "utf8");
    expect(packageJson).not.toMatch(/\b(?:retry|rerun)\b/i);
  });
});

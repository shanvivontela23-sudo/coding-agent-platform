import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const postgresMutatingTests = [
  "apps/api/tests/product-07-upload-http.integration.test.ts",
  "apps/api/tests/task-read-http.integration.test.ts",
  "apps/api/tests/tenant-api.integration.test.ts",
  "packages/db/tests/github-projects.test.ts",
  "packages/db/tests/invitations.test.ts",
  "packages/db/tests/task-intake.test.ts",
  "packages/db/tests/tenant-rls.test.ts",
] as const;

describe("PostgreSQL integration test scheduling", () => {
  it("runs every test that applies tenant migrations in one serial Vitest project", async () => {
    const config = await readFile("vitest.config.ts", "utf8").catch(() => "");

    expect(config).toContain('name: "postgres-serial"');
    expect(config).toContain("fileParallelism: false");
    expect(config).toContain("groupOrder: 1");
    for (const path of postgresMutatingTests) expect(config).toContain(`"${path}"`);
  });

  it("keeps the non-PostgreSQL test project ahead of the serial database phase", async () => {
    const config = await readFile("vitest.config.ts", "utf8").catch(() => "");

    expect(config).toContain('name: "parallel"');
    expect(config).toContain("groupOrder: 0");
  });
});

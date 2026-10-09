import { defineConfig } from "vitest/config";

const postgresMutatingTests = [
  "apps/api/tests/product-07-upload-http.integration.test.ts",
  "apps/api/tests/task-read-http.integration.test.ts",
  "apps/api/tests/tenant-api.integration.test.ts",
  "packages/db/tests/github-projects.test.ts",
  "packages/db/tests/invitations.test.ts",
  "packages/db/tests/task-intake.test.ts",
  "packages/db/tests/tenant-rls.test.ts",
] as const;

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "parallel",
          include: [
            "evals/tests/**/*.test.ts",
            "apps/**/*.test.ts",
            "packages/**/*.test.ts",
          ],
          exclude: [...postgresMutatingTests],
          sequence: { groupOrder: 0 },
        },
      },
      {
        test: {
          name: "postgres-serial",
          include: [...postgresMutatingTests],
          fileParallelism: false,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});

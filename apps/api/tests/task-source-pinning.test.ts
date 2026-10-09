import { describe, expect, it } from "vitest";
import { createTaskDatabase } from "../src/task-database.js";
import type { TenantPool } from "../src/database.js";

const session = { userId: "10000000-0000-4000-8000-000000000101", organizationId: "00000000-0000-4000-8000-000000000101", expiresAtMs: Date.now() + 60_000 };
const plan = {
  whatIUnderstand: "Fix the retry button.",
  proposedApproach: "Update the handler and cover it with a test.",
  size: "small" as const,
  estimate: { label: "Small", costUsdMin: 0.1, costUsdMax: 0.2, timeMinutesMin: 5, timeMinutesMax: 10 },
};

describe("task plan source pinning", () => {
  it("copies the report's GitHub commit into the task before plan_ready", async () => {
    const statements: string[] = [];
    const client = {
      async query<Row = Record<string, unknown>>(text: string) {
        statements.push(text);
        if (text.includes("FROM project_reports")) return { rows: [{ analysed_commit: "a".repeat(40), analysed_version_id: null }] as Row[] };
        return { rows: [] as Row[] };
      },
      release() {},
    };
    const database = createTaskDatabase({ connect: async () => client, query: client.query.bind(client) } as TenantPool);

    await database.savePlan(session, "40000000-0000-4000-8000-000000000101", plan);

    expect(statements.some((sql) => sql.includes("FROM project_reports") && sql.includes("analysed_commit") && sql.includes("analysed_version_id"))).toBe(true);
    const update = statements.find((sql) => sql.includes("UPDATE tasks SET"));
    expect(update).toContain("planned_source_commit_sha");
    expect(update).toContain("planned_source_version_id");
    expect(update).toContain("status='plan_ready'");
  });

  it("rejects plan_ready when the project report has no single analysable source", async () => {
    const client = {
      async query<Row = Record<string, unknown>>(text: string) {
        if (text.includes("FROM project_reports")) return { rows: [{ analysed_commit: null, analysed_version_id: null }] as Row[] };
        return { rows: [] as Row[] };
      },
      release() {},
    };
    const database = createTaskDatabase({ connect: async () => client, query: client.query.bind(client) } as TenantPool);
    await expect(database.savePlan(session, "40000000-0000-4000-8000-000000000101", plan)).rejects.toThrow(/source/i);
  });
});

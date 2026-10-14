import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("project decisions migration contract", () => {
  it("creates a forced-RLS tenant table with composite relationships and no hard-delete grant", async () => {
    const sql = await readFile("packages/db/migrations/0014_project_decisions.sql", "utf8");
    expect(sql).toContain("CREATE TABLE project_decisions");
    for (const column of ["organization_id", "project_id", "task_id", "kind", "summary", "detail", "source", "created_at", "superseded_by"]) expect(sql).toContain(column);
    expect(sql).toContain("char_length(summary) BETWEEN 1 AND 300");
    expect(sql).toMatch(/FOREIGN KEY \(organization_id, project_id\)\s+REFERENCES projects \(organization_id, id\)/);
    expect(sql).toMatch(/FOREIGN KEY \(organization_id, project_id, task_id\)\s+REFERENCES tasks \(organization_id, project_id, id\)/);
    expect(sql).toMatch(/FOREIGN KEY \(organization_id, superseded_by\)\s+REFERENCES project_decisions \(organization_id, id\)/);
    expect(sql).toContain("ALTER TABLE project_decisions ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("ALTER TABLE project_decisions FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("GRANT SELECT, INSERT, UPDATE ON project_decisions TO coding_agent_app");
    expect(sql).toContain("REVOKE DELETE ON project_decisions FROM coding_agent_app");
  });
});


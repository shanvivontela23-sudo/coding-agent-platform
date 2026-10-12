import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("B3 GitHub publication migration", () => {
  it("adds durable tenant-scoped publication state in 0009 without delete access", async () => {
    const sql = await readFile("packages/db/migrations/0009_github_publication.sql", "utf8");
    expect(sql).toContain("CREATE TABLE task_execution_publications");
    expect(sql).toContain("UNIQUE (organization_id, execution_id)");
    expect(sql).toContain("source_changed");
    expect(sql).toContain("base_moved_commits");
    expect(sql).toContain("pull_request_number");
    expect(sql).toContain("ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("GRANT SELECT, INSERT, UPDATE ON task_execution_publications TO coding_agent_app");
    expect(sql).toContain("REVOKE DELETE ON task_execution_publications FROM coding_agent_app");
  });
});

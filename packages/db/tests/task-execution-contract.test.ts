import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationPath = "packages/db/migrations/0006_task_execution.sql";

describe("Part B1 task execution migration contract", () => {
  it("adds source pins, execution persistence, leases, RLS, and cost linkage additively", async () => {
    const migration = await readFile(migrationPath, "utf8");
    for (const fragment of [
      "planned_source_commit_sha",
      "planned_source_version_id",
      "CREATE TABLE task_executions",
      "CREATE TABLE task_execution_checks",
      "CREATE TABLE task_execution_artifacts",
      "CREATE UNIQUE INDEX task_executions_one_active_per_task",
      "FOR UPDATE SKIP LOCKED",
      "CREATE OR REPLACE FUNCTION public.claim_task_execution",
      "CREATE OR REPLACE FUNCTION public.heartbeat_task_execution",
      "CREATE OR REPLACE FUNCTION public.finish_task_execution",
      "ALTER TABLE task_executions ENABLE ROW LEVEL SECURITY",
      "ALTER TABLE task_executions FORCE ROW LEVEL SECURITY",
      "ADD COLUMN task_execution_id uuid",
    ]) expect(migration).toContain(fragment);

    expect(migration).toMatch(/FOREIGN KEY \(organization_id, task_id\)[\s\S]*REFERENCES tasks \(organization_id, id\)/);
    expect(migration).toMatch(/FOREIGN KEY \(organization_id, project_id, source_version_id\)[\s\S]*REFERENCES project_versions \(organization_id, project_id, id\)/);
    expect(migration).toContain("REVOKE ALL ON FUNCTION public.claim_task_execution(text, integer) FROM PUBLIC");
    expect(migration).toContain("GRANT EXECUTE ON FUNCTION public.claim_task_execution(text, integer) TO coding_agent_api");
  });

  it("records only the new migration checksum without changing applied migration checksums", async () => {
    const migration = await readFile(migrationPath, "utf8");
    const checksums = JSON.parse(await readFile("packages/db/migrations/checksums.json", "utf8")) as Record<string, string>;
    expect(checksums).toMatchObject({
      "0001_tenant_core.sql": "a2bd51200e4232257004b121f9252af2e0920721120711815cd383c4c8a39725",
      "0002_organization_invitations.sql": "8a8d098b931dacadf72fbfd336fce6bc65646fbba3157ee3dfbdb1d8017e3935",
      "0003_github_projects.sql": "344d3c7cdc7dfcd04eea849ca06f5a33e5f13cc906f1d3e29e7613ef1a91514a",
      "0004_task_intake.sql": "2900e2b6fab38434ee910d9f43f7f378f1ec4c825ac155e0c9ecefcc20302f9d",
      "0005_zip_projects_and_task_review_fixes.sql": "7d22c83f60c3cbd01c3b1a313179e2bd6a9aaf6e664c8965526f650dba39e3f1",
    });
    expect(checksums["0006_task_execution.sql"]).toBe(createHash("sha256").update(migration).digest("hex"));
    expect(Object.keys(checksums)).toHaveLength(6);
  });
});

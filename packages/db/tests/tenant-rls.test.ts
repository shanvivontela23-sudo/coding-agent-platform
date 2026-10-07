import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { runTenantIsolationProbe } from "../src/tenant-isolation-probe.js";

const migrationPath = "packages/db/migrations/0001_tenant_core.sql";

describe("tenant data model", () => {
  it("puts organization_id and forced row-level security on tenant tables and users", async () => {
    const sql = await readFile(migrationPath, "utf8");
    for (const table of ["organization_memberships", "projects", "repositories", "tasks", "task_steps", "model_calls", "audit_events"]) {
      expect(sql).toContain(`CREATE TABLE ${table}`);
      expect(sql).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      expect(sql).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    }
    expect(sql).toContain("ALTER TABLE users ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("ALTER TABLE users FORCE ROW LEVEL SECURITY");
  });

  it("uses composite tenant foreign keys for project, repository and task references", async () => {
    const sql = await readFile(migrationPath, "utf8");
    expect(sql).toContain("FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, id)");
    expect(sql).toContain("FOREIGN KEY (organization_id, repository_id) REFERENCES repositories (organization_id, id)");
    expect(sql).toContain("FOREIGN KEY (organization_id, task_id) REFERENCES tasks (organization_id, id)");
  });

  it("enforces every cross-tenant reference, append-only audit events, and membership-scoped user visibility", async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (!databaseUrl) return;
    await expect(runTenantIsolationProbe(databaseUrl)).resolves.toEqual({
      tenantAVisibleProjects: 1,
      tenantBVisibleProjects: 0,
      crossTenantProjectReferenceRejected: true,
      crossTenantRepositoryReferenceRejected: true,
      crossTenantTaskReferenceRejected: true,
      auditUpdateDenied: true,
      auditDeleteDenied: true,
      tenantAVisibleUsers: 1,
      tenantBVisibleUsers: 0,
    });
  });
});

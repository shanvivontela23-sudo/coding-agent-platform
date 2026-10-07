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

  it("defines the non-superuser API login and only the two narrow SECURITY DEFINER entry points", async () => {
    const sql = await readFile(migrationPath, "utf8");
    expect(sql).toMatch(/CREATE ROLE coding_agent_api LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT/i);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.lookup_memberships_for_supabase_user\(uuid\)[\s\S]*SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, public/i);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.create_organization_with_owner\(uuid, text, text\)[\s\S]*SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, public/i);
    expect(sql).toContain("REVOKE ALL ON FUNCTION public.lookup_memberships_for_supabase_user(uuid) FROM PUBLIC");
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION public.lookup_memberships_for_supabase_user(uuid) TO coding_agent_api");
    expect(sql).toContain("REVOKE ALL ON FUNCTION public.create_organization_with_owner(uuid, text, text) FROM PUBLIC");
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION public.create_organization_with_owner(uuid, text, text) TO coding_agent_api");
    expect(sql).not.toMatch(/supabase_user_id[^\n]*current_setting|current_setting[^\n]*supabase_user_id/i);
  });

  it("enforces cross-tenant integrity, privileged function scope, onboarding refusal, audit immutability, and user visibility", async () => {
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
      apiRoleIsRestricted: true,
      apiDirectTenantReadDenied: true,
      membershipLookupOwnRowsOnly: true,
      onboardingCreatesOwnerMembership: true,
      onboardingRejectsExistingMembership: true,
      onboardingRejectsShortName: true,
      onboardingRejectsLongName: true,
      onboardingCannotAttachExistingOrganization: true,
    });
  });
});

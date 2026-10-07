import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const migrationPath = "packages/db/migrations/0001_tenant_core.sql";

export type TenantIsolationProbeResult = {
  readonly tenantAVisibleProjects: number;
  readonly tenantBVisibleProjects: number;
  readonly crossTenantRepositoryRejected: boolean;
  readonly auditUpdateDenied: boolean;
  readonly auditDeleteDenied: boolean;
  readonly tenantAVisibleUsers: number;
  readonly tenantBVisibleUsers: number;
};

async function psql(databaseUrl: string, sql: string): Promise<string> {
  const { stdout } = await execFileAsync("psql", [databaseUrl, "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8", maxBuffer: 1024 * 1024 });
  return stdout.trim();
}
async function fails(databaseUrl: string, sql: string): Promise<boolean> {
  try { await psql(databaseUrl, sql); return false; } catch { return true; }
}

export async function runTenantIsolationProbe(databaseUrl: string): Promise<TenantIsolationProbeResult> {
  await psql(databaseUrl, "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO CURRENT_USER;");
  await execFileAsync("psql", [databaseUrl, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", migrationPath], { encoding: "utf8" });

  const orgA = "00000000-0000-4000-8000-000000000001";
  const orgB = "00000000-0000-4000-8000-000000000002";
  const userA = "10000000-0000-4000-8000-000000000001";
  const userB = "10000000-0000-4000-8000-000000000002";
  const projectA = "20000000-0000-4000-8000-000000000001";
  const projectB = "20000000-0000-4000-8000-000000000002";
  const repository = "30000000-0000-4000-8000-000000000001";
  const audit = "40000000-0000-4000-8000-000000000001";
  await psql(databaseUrl, `
    INSERT INTO organizations (id,name) VALUES ('${orgA}','A'),('${orgB}','B');
    INSERT INTO users (id,supabase_user_id,email) VALUES
      ('${userA}','50000000-0000-4000-8000-000000000001','a@example.com'),
      ('${userB}','50000000-0000-4000-8000-000000000002','b@example.com');
    INSERT INTO organization_memberships (organization_id,user_id,role) VALUES ('${orgA}','${userA}','rep'),('${orgB}','${userB}','rep');
    INSERT INTO projects (id,organization_id,name) VALUES ('${projectA}','${orgA}','A project'),('${projectB}','${orgB}','B project');
  `);

  const crossTenantRepositoryRejected = await fails(databaseUrl, `INSERT INTO repositories (id,organization_id,project_id,provider,external_id,display_name) VALUES ('${repository}','${orgA}','${projectB}','github','x','bad');`);
  const counts = (await psql(databaseUrl, `SET ROLE coding_agent_app; SET app.organization_id='${orgA}'; SELECT (SELECT count(*) FROM projects) || ',' || (SELECT count(*) FROM projects WHERE organization_id='${orgB}') || ',' || (SELECT count(*) FROM users) || ',' || (SELECT count(*) FROM users WHERE id='${userB}');`)).split(",").map(Number);

  await psql(databaseUrl, `SET ROLE coding_agent_app; SET app.organization_id='${orgA}'; INSERT INTO audit_events (id,organization_id,actor_user_id,event_type) VALUES ('${audit}','${orgA}','${userA}','probe');`);
  const auditUpdateDenied = await fails(databaseUrl, `SET ROLE coding_agent_app; SET app.organization_id='${orgA}'; UPDATE audit_events SET event_type='changed' WHERE id='${audit}';`);
  const auditDeleteDenied = await fails(databaseUrl, `SET ROLE coding_agent_app; SET app.organization_id='${orgA}'; DELETE FROM audit_events WHERE id='${audit}';`);

  return {
    tenantAVisibleProjects: counts[0] ?? -1,
    tenantBVisibleProjects: counts[1] ?? -1,
    crossTenantRepositoryRejected,
    auditUpdateDenied,
    auditDeleteDenied,
    tenantAVisibleUsers: counts[2] ?? -1,
    tenantBVisibleUsers: counts[3] ?? -1,
  };
}

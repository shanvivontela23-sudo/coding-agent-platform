import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const migrationPath = "packages/db/migrations/0001_tenant_core.sql";

export type TenantIsolationProbeResult = {
  readonly tenantAVisibleProjects: number;
  readonly tenantBVisibleProjects: number;
  readonly crossTenantProjectReferenceRejected: boolean;
  readonly crossTenantRepositoryReferenceRejected: boolean;
  readonly crossTenantTaskReferenceRejected: boolean;
  readonly auditUpdateDenied: boolean;
  readonly auditDeleteDenied: boolean;
  readonly tenantAVisibleUsers: number;
  readonly tenantBVisibleUsers: number;
  readonly apiRoleIsRestricted: boolean;
  readonly apiDirectTenantReadDenied: boolean;
  readonly membershipLookupOwnRowsOnly: boolean;
  readonly onboardingCreatesOwnerMembership: boolean;
  readonly onboardingRejectsExistingMembership: boolean;
  readonly onboardingRejectsShortName: boolean;
  readonly onboardingRejectsLongName: boolean;
  readonly onboardingCannotAttachExistingOrganization: boolean;
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
  const supabaseA = "60000000-0000-4000-8000-000000000001";
  const supabaseB = "60000000-0000-4000-8000-000000000002";
  const projectA = "20000000-0000-4000-8000-000000000001";
  const projectB = "20000000-0000-4000-8000-000000000002";
  const repositoryA = "30000000-0000-4000-8000-000000000001";
  const repositoryB = "30000000-0000-4000-8000-000000000002";
  const taskB = "40000000-0000-4000-8000-000000000002";
  const audit = "50000000-0000-4000-8000-000000000001";

  await psql(databaseUrl, `
    INSERT INTO organizations (id,name) VALUES ('${orgA}','A'),('${orgB}','B');
    INSERT INTO users (id,supabase_user_id,email) VALUES
      ('${userA}','${supabaseA}','a@example.com'),
      ('${userB}','${supabaseB}','b@example.com');
    INSERT INTO organization_memberships (organization_id,user_id,role) VALUES ('${orgA}','${userA}','rep'),('${orgB}','${userB}','rep');
    INSERT INTO projects (id,organization_id,name) VALUES ('${projectA}','${orgA}','A project'),('${projectB}','${orgB}','B project');
    INSERT INTO repositories (id,organization_id,project_id,provider,external_id,display_name) VALUES
      ('${repositoryA}','${orgA}','${projectA}','github','a','A repo'),
      ('${repositoryB}','${orgB}','${projectB}','github','b','B repo');
    INSERT INTO tasks (id,organization_id,project_id,repository_id,requested_by_user_id,status,requirement) VALUES
      ('${taskB}','${orgB}','${projectB}','${repositoryB}','${userB}','open','B task');
  `);

  const crossTenantProjectReferenceRejected = await fails(databaseUrl, `
    INSERT INTO repositories (id,organization_id,project_id,provider,external_id,display_name)
    VALUES ('70000000-0000-4000-8000-000000000001','${orgA}','${projectB}','github','bad-project','bad');
  `);
  const crossTenantRepositoryReferenceRejected = await fails(databaseUrl, `
    INSERT INTO tasks (id,organization_id,project_id,repository_id,requested_by_user_id,status,requirement)
    VALUES ('70000000-0000-4000-8000-000000000002','${orgA}','${projectA}','${repositoryB}','${userA}','open','bad repo');
  `);
  const crossTenantTaskReferenceRejected = await fails(databaseUrl, `
    INSERT INTO task_steps (id,organization_id,task_id,step_key,status)
    VALUES ('70000000-0000-4000-8000-000000000003','${orgA}','${taskB}','bad','open');
  `);

  const counts = (await psql(databaseUrl, `SET ROLE coding_agent_app; SET app.organization_id='${orgA}'; SELECT (SELECT count(*) FROM projects) || ',' || (SELECT count(*) FROM projects WHERE organization_id='${orgB}') || ',' || (SELECT count(*) FROM users) || ',' || (SELECT count(*) FROM users WHERE id='${userB}');`)).split(",").map(Number);

  await psql(databaseUrl, `SET ROLE coding_agent_app; SET app.organization_id='${orgA}'; INSERT INTO audit_events (id,organization_id,actor_user_id,event_type) VALUES ('${audit}','${orgA}','${userA}','probe');`);
  const auditUpdateDenied = await fails(databaseUrl, `SET ROLE coding_agent_app; SET app.organization_id='${orgA}'; UPDATE audit_events SET event_type='changed' WHERE id='${audit}';`);
  const auditDeleteDenied = await fails(databaseUrl, `SET ROLE coding_agent_app; SET app.organization_id='${orgA}'; DELETE FROM audit_events WHERE id='${audit}';`);

  const apiRoleFlags = await psql(databaseUrl, "SELECT rolsuper::int || ',' || rolbypassrls::int || ',' || rolinherit::int || ',' || rolcanlogin::int FROM pg_roles WHERE rolname='coding_agent_api';");
  const apiRoleIsRestricted = apiRoleFlags === "0,0,0,1";
  const apiDirectTenantReadDenied = await fails(databaseUrl, "SET ROLE coding_agent_api; SELECT count(*) FROM public.projects;");
  const membershipLookup = await psql(databaseUrl, `SET ROLE coding_agent_api; SELECT user_id || ',' || organization_id FROM public.lookup_memberships_for_supabase_user('${supabaseA}');`);
  const membershipLookupOwnRowsOnly = membershipLookup === `${userA},${orgA}`;

  const onboardingSupabase = "60000000-0000-4000-8000-000000000003";
  const onboarding = (await psql(databaseUrl, `SET ROLE coding_agent_api; SELECT user_id || ',' || organization_id FROM public.create_organization_with_owner('${onboardingSupabase}',' new@example.com ','  New Org  ');`)).split(",");
  const onboardingUserId = onboarding[0] ?? "";
  const onboardingOrgId = onboarding[1] ?? "";
  const onboardingCheck = await psql(databaseUrl, `SELECT count(*) FROM public.organization_memberships m JOIN public.organizations o ON o.id=m.organization_id JOIN public.users u ON u.id=m.user_id WHERE m.user_id='${onboardingUserId}' AND m.organization_id='${onboardingOrgId}' AND m.role='owner' AND o.name='New Org' AND u.supabase_user_id='${onboardingSupabase}';`);
  const onboardingCreatesOwnerMembership = onboardingCheck === "1";

  const onboardingRejectsExistingMembership = await fails(databaseUrl, `SET ROLE coding_agent_api; SELECT * FROM public.create_organization_with_owner('${supabaseA}','a@example.com','Another Org');`);
  const onboardingRejectsShortName = await fails(databaseUrl, "SET ROLE coding_agent_api; SELECT * FROM public.create_organization_with_owner('60000000-0000-4000-8000-000000000004','short@example.com',' x ');");
  const onboardingRejectsLongName = await fails(databaseUrl, `SET ROLE coding_agent_api; SELECT * FROM public.create_organization_with_owner('60000000-0000-4000-8000-000000000005','long@example.com','${"x".repeat(81)}');`);

  const attachSupabase = "60000000-0000-4000-8000-000000000006";
  const attach = (await psql(databaseUrl, `SET ROLE coding_agent_api; SELECT user_id || ',' || organization_id FROM public.create_organization_with_owner('${attachSupabase}','attach@example.com','Existing Org');`)).split(",");
  const attachUserId = attach[0] ?? "";
  const generatedOrgId = attach[1] ?? "";
  const existingAttachCount = await psql(databaseUrl, `SELECT count(*) FROM public.organization_memberships WHERE user_id='${attachUserId}' AND organization_id='${orgA}';`);
  const onboardingCannotAttachExistingOrganization = generatedOrgId !== orgA && existingAttachCount === "0";

  return {
    tenantAVisibleProjects: counts[0] ?? -1,
    tenantBVisibleProjects: counts[1] ?? -1,
    crossTenantProjectReferenceRejected,
    crossTenantRepositoryReferenceRejected,
    crossTenantTaskReferenceRejected,
    auditUpdateDenied,
    auditDeleteDenied,
    tenantAVisibleUsers: counts[2] ?? -1,
    tenantBVisibleUsers: counts[3] ?? -1,
    apiRoleIsRestricted,
    apiDirectTenantReadDenied,
    membershipLookupOwnRowsOnly,
    onboardingCreatesOwnerMembership,
    onboardingRejectsExistingMembership,
    onboardingRejectsShortName,
    onboardingRejectsLongName,
    onboardingCannotAttachExistingOrganization,
  };
}

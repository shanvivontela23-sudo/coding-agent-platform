import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const baseDatabaseUrl = process.env.TEST_DATABASE_URL;
const integrationDb = "coding_agent_task_publication_b3";
const migrations = [
  "0001_tenant_core.sql", "0002_organization_invitations.sql", "0003_github_projects.sql", "0004_task_intake.sql",
  "0005_zip_projects_and_task_review_fixes.sql", "0006_task_execution.sql", "0007_task_execution_b2.sql",
  "0008_verification_incomplete.sql", "0009_github_publication.sql",
] as const;
const org = "00000000-0000-4000-8000-000000000711";
const user = "10000000-0000-4000-8000-000000000711";
const project = "20000000-0000-4000-8000-000000000711";
const task = "40000000-0000-4000-8000-000000000711";
const execution = "50000000-0000-4000-8000-000000000711";
const commit = "a".repeat(40);

function databaseUrlFor(name: string): string { const url = new URL(baseDatabaseUrl!); url.pathname = `/${name}`; return url.toString(); }
async function psql(databaseUrl: string, sql: string): Promise<string> {
  const { stdout } = await execFileAsync("psql", [databaseUrl, "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8" });
  return stdout.trim();
}
async function expectPsqlFailure(databaseUrl: string, sql: string): Promise<void> { await expect(psql(databaseUrl, sql)).rejects.toThrow(); }

beforeAll(async () => {
  if (!baseDatabaseUrl) return;
  await psql(baseDatabaseUrl, `DROP DATABASE IF EXISTS ${integrationDb} WITH (FORCE)`);
  await psql(baseDatabaseUrl, `CREATE DATABASE ${integrationDb}`);
  const url = databaseUrlFor(integrationDb);
  for (const migration of migrations) await execFileAsync("psql", [url, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", `packages/db/migrations/${migration}`], { encoding: "utf8" });
  await psql(url, `
    INSERT INTO organizations (id,name) VALUES ('${org}','B3 Publication');
    INSERT INTO users (id,supabase_user_id,email) VALUES ('${user}','60000000-0000-4000-8000-000000000711','dev-b3@example.com');
    INSERT INTO organization_memberships (organization_id,user_id,role) VALUES ('${org}','${user}','developer');
    INSERT INTO projects (id,organization_id,name) VALUES ('${project}','${org}','Demo');
    INSERT INTO project_reports (organization_id,project_id,report,analysed_commit) VALUES ('${org}','${project}','{"installCommand":"npm ci"}'::jsonb,'${commit}');
    INSERT INTO tasks (id,organization_id,project_id,requested_by_user_id,status,requirement,task_model_budget_usd) VALUES ('${task}','${org}','${project}','${user}','draft','Fix retry',0.50);
    UPDATE tasks SET status='plan_ready',what_i_understand='Fix retry',proposed_approach='Update src/retry.ts' WHERE id='${task}';
    UPDATE tasks SET status='approved',confirmed_requirement='Fix retry',confirmed_plan='Update src/retry.ts',approved_at=now() WHERE id='${task}';
    INSERT INTO task_executions (id,organization_id,task_id,project_id,attempt,started_by_user_id,source_commit_sha,budget_usd,timeout_seconds,status,finished_at,result_patch,change_document)
      VALUES ('${execution}','${org}','${task}','${project}',1,'${user}','${commit}',1.00,600,'succeeded',now(),'diff --git a/src/retry.ts b/src/retry.ts','## What was asked');
  `);
}, 30_000);

afterAll(async () => { if (baseDatabaseUrl) await psql(baseDatabaseUrl, `DROP DATABASE IF EXISTS ${integrationDb} WITH (FORCE)`); }, 30_000);

describe.skipIf(!baseDatabaseUrl)("B3 publication database boundary", () => {
  it("allows tenant-scoped insert/update but not delete, duplicate rows, or downgrade after published", async () => {
    const url = databaseUrlFor(integrationDb);
    expect(await psql(url, `
      SET ROLE coding_agent_app;
      SELECT pg_catalog.set_config('app.organization_id','${org}',false);
      INSERT INTO task_execution_publications (organization_id,task_id,execution_id,requested_by_user_id,status,branch_name,approved_sha)
        VALUES ('${org}','${task}','${execution}','${user}','publishing','dhara/execution-${execution}','${commit}');
      UPDATE task_execution_publications SET status='published',base_moved_commits=3,pull_request_number=12,pull_request_url='https://github.com/acme/demo/pull/12' WHERE execution_id='${execution}';
      SELECT status||'|'||base_moved_commits||'|'||pull_request_number FROM task_execution_publications WHERE execution_id='${execution}';
    `)).toContain("published|3|12");
    await expectPsqlFailure(url, `SET ROLE coding_agent_app; SELECT pg_catalog.set_config('app.organization_id','${org}',false); UPDATE task_execution_publications SET status='failed',failure_code='LATE_FAILURE' WHERE execution_id='${execution}';`);
    await expectPsqlFailure(url, `SET ROLE coding_agent_app; SELECT pg_catalog.set_config('app.organization_id','${org}',false); DELETE FROM task_execution_publications WHERE execution_id='${execution}';`);
    await expectPsqlFailure(url, `SET ROLE coding_agent_app; SELECT pg_catalog.set_config('app.organization_id','${org}',false); INSERT INTO task_execution_publications (organization_id,task_id,execution_id,requested_by_user_id,status,branch_name,approved_sha) VALUES ('${org}','${task}','${execution}','${user}','publishing','other','${commit}');`);
  });
});

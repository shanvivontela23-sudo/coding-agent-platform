import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const baseDatabaseUrl = process.env.TEST_DATABASE_URL;
const integrationDb = "coding_agent_task_execution";
const migrations = [
  "packages/db/migrations/0001_tenant_core.sql",
  "packages/db/migrations/0002_organization_invitations.sql",
  "packages/db/migrations/0003_github_projects.sql",
  "packages/db/migrations/0004_task_intake.sql",
  "packages/db/migrations/0005_zip_projects_and_task_review_fixes.sql",
  "packages/db/migrations/0006_task_execution.sql",
] as const;

const org = "00000000-0000-4000-8000-000000000111";
const rep = "10000000-0000-4000-8000-000000000111";
const project = "20000000-0000-4000-8000-000000000111";
const task = "40000000-0000-4000-8000-000000000111";
const execution = "50000000-0000-4000-8000-000000000111";
const commit = "a".repeat(40);

function databaseUrlFor(name: string): string { const url = new URL(baseDatabaseUrl!); url.pathname = `/${name}`; return url.toString(); }
async function psql(databaseUrl: string, sql: string): Promise<string> {
  const { stdout } = await execFileAsync("psql", [databaseUrl, "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8" });
  return stdout.trim();
}

beforeAll(async () => {
  if (!baseDatabaseUrl) return;
  await psql(baseDatabaseUrl, `DROP DATABASE IF EXISTS ${integrationDb} WITH (FORCE)`);
  await psql(baseDatabaseUrl, `CREATE DATABASE ${integrationDb}`);
  const databaseUrl = databaseUrlFor(integrationDb);
  for (const migration of migrations) await execFileAsync("psql", [databaseUrl, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", migration], { encoding: "utf8" });
  await psql(databaseUrl, `
    INSERT INTO organizations (id,name) VALUES ('${org}','Execution Org');
    INSERT INTO users (id,supabase_user_id,email) VALUES ('${rep}','60000000-0000-4000-8000-000000000111','rep@example.com');
    INSERT INTO organization_memberships (organization_id,user_id,role) VALUES ('${org}','${rep}','rep');
    INSERT INTO projects (id,organization_id,name) VALUES ('${project}','${org}','Demo');
    INSERT INTO project_reports (organization_id,project_id,report,analysed_commit) VALUES ('${org}','${project}','{}'::jsonb,'${commit}');
    INSERT INTO tasks (id,organization_id,project_id,requested_by_user_id,status,requirement,task_model_budget_usd)
      VALUES ('${task}','${org}','${project}','${rep}','draft','Fix retry',0.50);
  `);
}, 30_000);

afterAll(async () => { if (baseDatabaseUrl) await psql(baseDatabaseUrl, `DROP DATABASE IF EXISTS ${integrationDb} WITH (FORCE)`); }, 30_000);

describe.skipIf(!baseDatabaseUrl)("task execution persistence and queue", () => {
  it("pins the analysed source exactly when the task becomes plan_ready", async () => {
    const databaseUrl = databaseUrlFor(integrationDb);
    await psql(databaseUrl, `SET ROLE coding_agent_app; SET app.organization_id='${org}'; UPDATE tasks SET status='plan_ready' WHERE id='${task}';`);
    expect(await psql(databaseUrl, `SET ROLE coding_agent_app; SET app.organization_id='${org}'; SELECT planned_source_commit_sha||'|'||COALESCE(planned_source_version_id::text,'') FROM tasks WHERE id='${task}';`)).toBe(`${commit}|`);
  });

  it("claims and reclaims the same leased execution without creating another attempt", async () => {
    const databaseUrl = databaseUrlFor(integrationDb);
    await psql(databaseUrl, `
      SET ROLE coding_agent_app; SET app.organization_id='${org}';
      UPDATE tasks SET status='approved', confirmed_requirement='Fix retry', confirmed_plan='Change retry behavior', approved_at=now() WHERE id='${task}';
      INSERT INTO task_executions (id,organization_id,task_id,project_id,attempt,started_by_user_id,source_commit_sha,budget_usd,timeout_seconds)
        VALUES ('${execution}','${org}','${task}','${project}',1,'${rep}','${commit}',1.00,120);
    `);
    expect(await psql(databaseUrl, `SET ROLE coding_agent_api; SELECT execution_id FROM public.claim_task_execution('worker-a',30);`)).toBe(execution);
    expect(await psql(databaseUrl, `SET ROLE coding_agent_api; SELECT count(*) FROM public.claim_task_execution('worker-b',30);`)).toBe("0");
    await psql(databaseUrl, `RESET ROLE; UPDATE task_executions SET lease_expires_at=now()-interval '1 second' WHERE id='${execution}';`);
    expect(await psql(databaseUrl, `SET ROLE coding_agent_api; SELECT execution_id FROM public.claim_task_execution('worker-b',30);`)).toBe(execution);
    expect(await psql(databaseUrl, `SELECT count(*) FROM task_executions WHERE task_id='${task}';`)).toBe("1");
    expect(await psql(databaseUrl, `SET ROLE coding_agent_api; SELECT public.finish_task_execution('${execution}','worker-b','succeeded',NULL,NULL);`)).toBe("succeeded");
  });
});

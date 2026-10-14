import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const baseDatabaseUrl = process.env.TEST_DATABASE_URL;
const integrationDb = "coding_agent_stack_skill_profile";
const org = "00000000-0000-4000-8000-000000000413";
const otherOrg = "00000000-0000-4000-8000-000000000414";
const rep = "10000000-0000-4000-8000-000000000413";
const project = "20000000-0000-4000-8000-000000000413";
const task = "40000000-0000-4000-8000-000000000413";
const execution = "50000000-0000-4000-8000-000000000413";
const commit = "d".repeat(40);

function databaseUrlFor(name: string): string {
  const url = new URL(baseDatabaseUrl!);
  url.pathname = `/${name}`;
  return url.toString();
}

async function psql(databaseUrl: string, sql: string): Promise<string> {
  const { stdout } = await execFileAsync("psql", [databaseUrl, "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8" });
  return stdout.trim();
}

const asApp = (organizationId: string, sql: string) => `SET ROLE coding_agent_app; SELECT pg_catalog.set_config('app.organization_id','${organizationId}',false); ${sql}`;

beforeAll(async () => {
  if (!baseDatabaseUrl) return;
  await psql(baseDatabaseUrl, `DROP DATABASE IF EXISTS ${integrationDb} WITH (FORCE)`);
  await psql(baseDatabaseUrl, `CREATE DATABASE ${integrationDb}`);
  const databaseUrl = databaseUrlFor(integrationDb);
  const migrations = (await readdir("packages/db/migrations")).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
  for (const migration of migrations) {
    await execFileAsync("psql", [databaseUrl, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", `packages/db/migrations/${migration}`], { encoding: "utf8" });
  }
  await psql(databaseUrl, `
    INSERT INTO organizations (id,name) VALUES ('${org}','Stack skills'),('${otherOrg}','Other');
    INSERT INTO users (id,supabase_user_id,email) VALUES ('${rep}','60000000-0000-4000-8000-000000000413','rep-skills@example.com');
    INSERT INTO organization_memberships (organization_id,user_id,role) VALUES ('${org}','${rep}','rep');
    INSERT INTO projects (id,organization_id,name) VALUES ('${project}','${org}','Demo');
    INSERT INTO project_reports (organization_id,project_id,report,analysed_commit) VALUES ('${org}','${project}','{}'::jsonb,'${commit}');
    INSERT INTO tasks (id,organization_id,project_id,requested_by_user_id,status,requirement,task_model_budget_usd)
      VALUES ('${task}','${org}','${project}','${rep}','draft','Fix retry',0.50);
    UPDATE tasks SET status='plan_ready',what_i_understand='Fix retry',proposed_approach='Change retry' WHERE id='${task}';
    UPDATE tasks SET status='approved',confirmed_requirement='Fix retry',confirmed_plan='Change retry',approved_at=now() WHERE id='${task}';
    INSERT INTO task_executions (id,organization_id,task_id,project_id,attempt,started_by_user_id,source_commit_sha,budget_usd,timeout_seconds)
      VALUES ('${execution}','${org}','${task}','${project}',1,'${rep}','${commit}',1.00,900);
  `);
}, 60_000);

afterAll(async () => {
  if (baseDatabaseUrl) await psql(baseDatabaseUrl, `DROP DATABASE IF EXISTS ${integrationDb} WITH (FORCE)`);
}, 30_000);

describe.skipIf(!baseDatabaseUrl)("0013 stack skill execution profile", () => {
  it("leaves existing rows readable with null skill metadata", async () => {
    const databaseUrl = databaseUrlFor(integrationDb);
    expect(await psql(databaseUrl, `SELECT coalesce(planning_skill_id,'null') FROM tasks WHERE id='${task}'`)).toBe("null");
    expect(await psql(databaseUrl, `SELECT coalesce(execution_profile::text,'null')||'|'||coalesce(sandbox_template_id,'null') FROM task_executions WHERE id='${execution}'`)).toBe("null|null");
  });

  it("rejects malformed metadata", async () => {
    const databaseUrl = databaseUrlFor(integrationDb);
    await expect(psql(databaseUrl, `UPDATE tasks SET planning_skill_id='typescript-node' WHERE id='${task}'`)).rejects.toThrow();
    await expect(psql(databaseUrl, `UPDATE tasks SET planning_skill_id='Bad Id',planning_skill_version='1.0.0' WHERE id='${task}'`)).rejects.toThrow();
    await expect(psql(databaseUrl, `UPDATE task_executions SET execution_profile='[]'::jsonb,sandbox_template_id='t' WHERE id='${execution}'`)).rejects.toThrow();
    await expect(psql(databaseUrl, `UPDATE task_executions SET execution_profile='{}'::jsonb WHERE id='${execution}'`)).rejects.toThrow();
  });

  it("lets the tenant app role write and read the new columns only inside its organization", async () => {
    const databaseUrl = databaseUrlFor(integrationDb);
    await psql(databaseUrl, asApp(org, `UPDATE tasks SET planning_skill_id='typescript-node',planning_skill_version='1.0.0' WHERE id='${task}';
      UPDATE task_executions SET execution_profile='{"v":1}'::jsonb,sandbox_template_id='tpl-a',implementation_skill_id='typescript-node',implementation_skill_version='1.0.0' WHERE id='${execution}';`));
    expect(await psql(databaseUrl, asApp(org, `SELECT planning_skill_version FROM tasks WHERE id='${task}';`))).toContain("1.0.0");
    expect(await psql(databaseUrl, asApp(org, `SELECT sandbox_template_id FROM task_executions WHERE id='${execution}';`))).toContain("tpl-a");
    expect(await psql(databaseUrl, asApp(otherOrg, `SELECT count(*) FROM task_executions WHERE id='${execution}';`))).toMatch(/0$/);
    await expect(psql(databaseUrl, `SET ROLE coding_agent_worker; SELECT execution_profile FROM task_executions;`)).rejects.toThrow();
  });
});

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const baseDatabaseUrl = process.env.TEST_DATABASE_URL;
const integrationDb = "coding_agent_task_intake";
const migrations = [
  "packages/db/migrations/0001_tenant_core.sql",
  "packages/db/migrations/0002_organization_invitations.sql",
  "packages/db/migrations/0003_github_projects.sql",
  "packages/db/migrations/0004_task_intake.sql",
] as const;

const org = "00000000-0000-4000-8000-000000000091";
const rep = "10000000-0000-4000-8000-000000000091";
const developer = "10000000-0000-4000-8000-000000000092";
const project = "20000000-0000-4000-8000-000000000091";
const repository = "30000000-0000-4000-8000-000000000091";
const task = "40000000-0000-4000-8000-000000000091";

function databaseUrlFor(name: string): string { const url = new URL(baseDatabaseUrl!); url.pathname = `/${name}`; return url.toString(); }
async function psql(databaseUrl: string, sql: string): Promise<string> { const { stdout } = await execFileAsync("psql", [databaseUrl, "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8" }); return stdout.trim(); }

beforeAll(async () => {
  if (!baseDatabaseUrl) return;
  await psql(baseDatabaseUrl, `DROP DATABASE IF EXISTS ${integrationDb} WITH (FORCE)`);
  await psql(baseDatabaseUrl, `CREATE DATABASE ${integrationDb}`);
  const databaseUrl = databaseUrlFor(integrationDb);
  for (const migration of migrations) await execFileAsync("psql", [databaseUrl, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", migration], { encoding: "utf8" });
  await psql(databaseUrl, `
    INSERT INTO organizations (id,name) VALUES ('${org}','Task Org');
    INSERT INTO users (id,supabase_user_id,email) VALUES
      ('${rep}','60000000-0000-4000-8000-000000000091','rep@example.com'),
      ('${developer}','60000000-0000-4000-8000-000000000092','dev@example.com');
    INSERT INTO organization_memberships (organization_id,user_id,role) VALUES
      ('${org}','${rep}','rep'),('${org}','${developer}','developer');
    INSERT INTO projects (id,organization_id,name) VALUES ('${project}','${org}','Demo');
    INSERT INTO repositories (id,organization_id,project_id,provider,external_id,display_name,github_repository_id,full_name,default_branch,last_analysed_commit)
      VALUES ('${repository}','${org}','${project}','github','91','demo','91','acme/demo','main','${"a".repeat(40)}');
  `);
}, 30_000);

afterAll(async () => { if (baseDatabaseUrl) await psql(baseDatabaseUrl, `DROP DATABASE IF EXISTS ${integrationDb} WITH (FORCE)`); }, 30_000);

describe("task intake migration", () => {
  it("adds encrypted ticket, clarification, plan and approval storage without editing older migrations", async () => {
    const sql = await readFile("packages/db/migrations/0004_task_intake.sql", "utf8");
    expect(sql).toContain("ALTER TABLE tasks");
    expect(sql).toContain("original_ticket_encrypted");
    expect(sql).toContain("masked_ticket");
    expect(sql).toContain("confirmed_requirement");
    expect(sql).toContain("confirmed_plan");
    expect(sql).toContain("task_questions");
    expect(sql).toContain("routed_to_user_id");
    expect(sql).toContain("task_model_budget_usd");
    expect(sql).toContain("ENABLE ROW LEVEL SECURITY");
  });
});

describe.skipIf(!baseDatabaseUrl)("task intake persistence", () => {
  it("stores an encrypted original, questions and approved requirement/plan tenant-scoped", async () => {
    const databaseUrl = databaseUrlFor(integrationDb);
    await psql(databaseUrl, `
      INSERT INTO tasks (id,organization_id,project_id,repository_id,requested_by_user_id,status,requirement,original_ticket_encrypted,masked_ticket,task_model_budget_usd)
      VALUES ('${task}','${org}','${project}','${repository}','${rep}','waiting_for_answers','masked','ciphertext','masked',0.50);
      INSERT INTO task_questions (id,organization_id,task_id,ordinal,question,suggested_answer,answer,answer_status,routed_to_user_id)
      VALUES (gen_random_uuid(),'${org}','${task}',1,'What should happen?','Retry','I don''t know','developer_needed','${developer}');
      UPDATE tasks SET status='approved', confirmed_requirement='Keep the value visible.', confirmed_plan='Allow retry.', approved_at=now() WHERE id='${task}';
    `);
    expect(await psql(databaseUrl, `SET ROLE coding_agent_app; SET app.organization_id='${org}'; SELECT status||'|'||confirmed_requirement||'|'||confirmed_plan FROM tasks WHERE id='${task}';`)).toBe("approved|Keep the value visible.|Allow retry.");
    expect(await psql(databaseUrl, `SET ROLE coding_agent_app; SET app.organization_id='${org}'; SELECT answer_status||'|'||routed_to_user_id FROM task_questions WHERE task_id='${task}';`)).toBe(`developer_needed|${developer}`);
  });
});

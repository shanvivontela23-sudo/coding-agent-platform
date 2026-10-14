import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const baseDatabaseUrl = process.env.TEST_DATABASE_URL;
const integrationDb = "coding_agent_project_decisions";
const orgA = "00000000-0000-4000-8000-000000000501";
const orgB = "00000000-0000-4000-8000-000000000502";
const repA = "10000000-0000-4000-8000-000000000501";
const projectA = "20000000-0000-4000-8000-000000000501";
const taskA = "40000000-0000-4000-8000-000000000501";
const decisionA = "50000000-0000-4000-8000-000000000501";

function databaseUrlFor(name: string): string { const url = new URL(baseDatabaseUrl!); url.pathname = `/${name}`; return url.toString(); }
async function psql(databaseUrl: string, sql: string): Promise<string> { const { stdout } = await execFileAsync("psql", [databaseUrl, "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8" }); return stdout.trim(); }
const asApp = (organizationId: string, sql: string) => `SET ROLE coding_agent_app; SELECT pg_catalog.set_config('app.organization_id','${organizationId}',false); ${sql}`;

beforeAll(async () => {
  if (!baseDatabaseUrl) return;
  await psql(baseDatabaseUrl, `DROP DATABASE IF EXISTS ${integrationDb} WITH (FORCE)`);
  await psql(baseDatabaseUrl, `CREATE DATABASE ${integrationDb}`);
  const databaseUrl = databaseUrlFor(integrationDb);
  const migrations = (await readdir("packages/db/migrations")).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
  for (const migration of migrations) await execFileAsync("psql", [databaseUrl, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", `packages/db/migrations/${migration}`], { encoding: "utf8" });
  await psql(databaseUrl, `
    INSERT INTO organizations (id,name) VALUES ('${orgA}','A'),('${orgB}','B');
    INSERT INTO users (id,supabase_user_id,email) VALUES ('${repA}','60000000-0000-4000-8000-000000000501','rep@example.com');
    INSERT INTO organization_memberships (organization_id,user_id,role) VALUES ('${orgA}','${repA}','rep');
    INSERT INTO projects (id,organization_id,name) VALUES ('${projectA}','${orgA}','Demo');
    INSERT INTO tasks (id,organization_id,project_id,requested_by_user_id,status,requirement) VALUES ('${taskA}','${orgA}','${projectA}','${repA}','draft','masked');
  `);
}, 60_000);

afterAll(async () => { if (baseDatabaseUrl) await psql(baseDatabaseUrl, `DROP DATABASE IF EXISTS ${integrationDb} WITH (FORCE)`); }, 30_000);

describe.skipIf(!baseDatabaseUrl)("project decision tenant persistence", () => {
  it("isolates rows and supports soft superseding without hard delete", async () => {
    const databaseUrl = databaseUrlFor(integrationDb);
    await psql(databaseUrl, asApp(orgA, `INSERT INTO project_decisions (id,organization_id,project_id,task_id,kind,summary,detail,source) VALUES ('${decisionA}','${orgA}','${projectA}','${taskA}','command_worked','pnpm test worked','{}','verification');`));
    expect(await psql(databaseUrl, asApp(orgA, `SELECT summary FROM project_decisions WHERE id='${decisionA}';`))).toContain("pnpm test worked");
    expect(await psql(databaseUrl, asApp(orgB, `SELECT count(*) FROM project_decisions WHERE id='${decisionA}';`))).toMatch(/0$/);
    await psql(databaseUrl, asApp(orgA, `UPDATE project_decisions SET superseded_by=id WHERE id='${decisionA}';`));
    expect(await psql(databaseUrl, asApp(orgA, `SELECT count(*) FROM project_decisions WHERE superseded_by IS NULL;`))).toMatch(/0$/);
    await expect(psql(databaseUrl, asApp(orgA, `DELETE FROM project_decisions WHERE id='${decisionA}';`))).rejects.toThrow();
  });

  it("rejects a cross-tenant project relationship", async () => {
    const databaseUrl = databaseUrlFor(integrationDb);
    await expect(psql(databaseUrl, asApp(orgB, `INSERT INTO project_decisions (id,organization_id,project_id,kind,summary,detail,source) VALUES (gen_random_uuid(),'${orgB}','${projectA}','convention','bad','{}','verification');`))).rejects.toThrow();
  });
});


import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const baseDatabaseUrl = process.env.TEST_DATABASE_URL;
const integrationDb = "coding_agent_github_projects";
const orgA = "00000000-0000-4000-8000-000000000071";
const orgB = "00000000-0000-4000-8000-000000000072";
const userA = "10000000-0000-4000-8000-000000000071";
const userB = "10000000-0000-4000-8000-000000000072";
function databaseUrlFor(name: string): string { const url = new URL(baseDatabaseUrl!); url.pathname = `/${name}`; return url.toString(); }
async function psql(url: string, sql: string): Promise<string> { const { stdout } = await execFileAsync("psql", [url, "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8" }); return stdout.trim(); }
async function fails(url: string, sql: string): Promise<boolean> { try { await psql(url, sql); return false; } catch { return true; } }

beforeAll(async () => {
  if (!baseDatabaseUrl) return;
  await psql(baseDatabaseUrl, `DROP DATABASE IF EXISTS ${integrationDb} WITH (FORCE)`); await psql(baseDatabaseUrl, `CREATE DATABASE ${integrationDb}`);
  const url = databaseUrlFor(integrationDb);
  for (const file of ["0001_tenant_core.sql", "0002_organization_invitations.sql", "0003_github_projects.sql"]) await execFileAsync("psql", [url, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", `packages/db/migrations/${file}`], { encoding: "utf8" });
  await psql(url, `INSERT INTO organizations (id,name) VALUES ('${orgA}','A'),('${orgB}','B'); INSERT INTO users (id,supabase_user_id,email) VALUES ('${userA}','60000000-0000-4000-8000-000000000071','a@example.com'),('${userB}','60000000-0000-4000-8000-000000000072','b@example.com'); INSERT INTO organization_memberships (organization_id,user_id,role) VALUES ('${orgA}','${userA}','owner'),('${orgB}','${userB}','owner');`);
}, 30_000);
afterAll(async () => { if (baseDatabaseUrl) await psql(baseDatabaseUrl, `DROP DATABASE IF EXISTS ${integrationDb} WITH (FORCE)`); }, 30_000);

describe("GitHub project persistence", () => {
  it("keeps installation bindings tenant-scoped and globally unique", async () => {
    const url = databaseUrlFor(integrationDb);
    await psql(url, `SET ROLE coding_agent_app; SET app.organization_id='${orgA}'; INSERT INTO github_installations (organization_id,installation_id,connected_by_user_id,status) VALUES ('${orgA}',44,'${userA}','connected');`);
    expect(await fails(url, `SET ROLE coding_agent_app; SET app.organization_id='${orgB}'; INSERT INTO github_installations (organization_id,installation_id,connected_by_user_id,status) VALUES ('${orgB}',44,'${userB}','connected');`)).toBe(true);
    expect(await psql(url, `SET ROLE coding_agent_app; SET app.organization_id='${orgA}'; SELECT installation_id FROM github_installations;`)).toBe("44");
    expect(await psql(url, `SET ROLE coding_agent_app; SET app.organization_id='${orgB}'; SELECT count(*) FROM github_installations;`)).toBe("0");
  });
  it("stores no GitHub access token column", async () => { const sql = await readFile("packages/db/migrations/0003_github_projects.sql", "utf8"); expect(sql).not.toMatch(/access_token|user_token|installation_token/i); });
});

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const baseDatabaseUrl = process.env.TEST_DATABASE_URL;
const integrationDb = "coding_agent_github_projects";
const migrations = [
  "packages/db/migrations/0001_tenant_core.sql",
  "packages/db/migrations/0002_organization_invitations.sql",
  "packages/db/migrations/0003_github_projects.sql",
] as const;

const orgA = "00000000-0000-4000-8000-000000000081";
const orgB = "00000000-0000-4000-8000-000000000082";
const userA = "10000000-0000-4000-8000-000000000081";
const userB = "10000000-0000-4000-8000-000000000082";

function databaseUrlFor(name: string): string {
  const url = new URL(baseDatabaseUrl!);
  url.pathname = `/${name}`;
  return url.toString();
}

async function psql(databaseUrl: string, sql: string): Promise<string> {
  const { stdout } = await execFileAsync("psql", [databaseUrl, "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8" });
  return stdout.trim();
}

async function fails(databaseUrl: string, sql: string): Promise<boolean> {
  try { await psql(databaseUrl, sql); return false; } catch { return true; }
}

beforeAll(async () => {
  if (!baseDatabaseUrl) return;
  await psql(baseDatabaseUrl, `DROP DATABASE IF EXISTS ${integrationDb} WITH (FORCE)`);
  await psql(baseDatabaseUrl, `CREATE DATABASE ${integrationDb}`);
  const databaseUrl = databaseUrlFor(integrationDb);
  for (const migration of migrations) {
    await execFileAsync("psql", [databaseUrl, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", migration], { encoding: "utf8" });
  }
  await psql(databaseUrl, `
    INSERT INTO organizations (id,name) VALUES ('${orgA}','A'),('${orgB}','B');
    INSERT INTO users (id,supabase_user_id,email) VALUES
      ('${userA}','60000000-0000-4000-8000-000000000081','a@example.com'),
      ('${userB}','60000000-0000-4000-8000-000000000082','b@example.com');
    INSERT INTO organization_memberships (organization_id,user_id,role) VALUES
      ('${orgA}','${userA}','owner'),
      ('${orgB}','${userB}','owner');
  `);
}, 30_000);

afterAll(async () => {
  if (baseDatabaseUrl) await psql(baseDatabaseUrl, `DROP DATABASE IF EXISTS ${integrationDb} WITH (FORCE)`);
}, 30_000);

describe("GitHub project migration", () => {
  it("stores installation state, repository metadata and only the derived report", async () => {
    const sql = await readFile("packages/db/migrations/0003_github_projects.sql", "utf8");
    expect(sql).toContain("CREATE TABLE github_installations");
    expect(sql).toContain("CREATE TABLE github_connection_states");
    expect(sql).toContain("CREATE TABLE project_reports");
    expect(sql).toContain("installation_id bigint");
    expect(sql).toContain("status text");
    expect(sql).toContain("nonce_hash");
    expect(sql).toContain("consumed_at");
    expect(sql).toContain("github_repository_id bigint");
    expect(sql).toContain("full_name text");
    expect(sql).toContain("default_branch text");
    expect(sql).toContain("last_analysed_commit");
    expect(sql).toContain("report jsonb");
    expect(sql).not.toMatch(/archive|snapshot|file_contents|repository_contents/i);
  });
});

describe.skipIf(!baseDatabaseUrl)("GitHub installation binding integrity", () => {
  it("refuses one GitHub installation id across two Dhara organizations", async () => {
    const databaseUrl = databaseUrlFor(integrationDb);
    await psql(databaseUrl, `INSERT INTO github_installations (organization_id, installation_id, connected_by_user_id, status) VALUES ('${orgA}',42,'${userA}','connected');`);
    expect(await fails(databaseUrl, `INSERT INTO github_installations (organization_id, installation_id, connected_by_user_id, status) VALUES ('${orgB}',42,'${userB}','connected');`)).toBe(true);
  });

  it("keeps a connection state tenant/user bound and consumable only once", async () => {
    const databaseUrl = databaseUrlFor(integrationDb);
    await psql(databaseUrl, `INSERT INTO github_connection_states (nonce_hash, organization_id, user_id, expires_at) VALUES ('${"a".repeat(64)}','${orgA}','${userA}',now()+interval '10 minutes');`);
    expect(await psql(databaseUrl, `UPDATE github_connection_states SET consumed_at=now() WHERE nonce_hash='${"a".repeat(64)}' AND organization_id='${orgA}' AND user_id='${userA}' AND consumed_at IS NULL AND expires_at > now() RETURNING 1;`)).toBe("1");
    expect(await psql(databaseUrl, `UPDATE github_connection_states SET consumed_at=now() WHERE nonce_hash='${"a".repeat(64)}' AND organization_id='${orgA}' AND user_id='${userA}' AND consumed_at IS NULL AND expires_at > now() RETURNING 1;`)).toBe("");
  });
});
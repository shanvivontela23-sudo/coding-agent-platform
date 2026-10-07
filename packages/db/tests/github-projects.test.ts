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

const org1 = "00000000-0000-4000-8000-000000000081";
const org2 = "00000000-0000-4000-8000-000000000082";
const user1 = "10000000-0000-4000-8000-000000000081";
const user2 = "10000000-0000-4000-8000-000000000082";

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
    INSERT INTO organizations (id, name) VALUES ('${org1}', 'One'), ('${org2}', 'Two');
    INSERT INTO users (id, supabase_user_id, email) VALUES
      ('${user1}', '60000000-0000-4000-8000-000000000081', 'one@example.com'),
      ('${user2}', '60000000-0000-4000-8000-000000000082', 'two@example.com');
    INSERT INTO organization_memberships (organization_id, user_id, role) VALUES
      ('${org1}', '${user1}', 'owner'), ('${org2}', '${user2}', 'owner');
  `);
}, 30_000);

afterAll(async () => {
  if (baseDatabaseUrl) await psql(baseDatabaseUrl, `DROP DATABASE IF EXISTS ${integrationDb} WITH (FORCE)`);
}, 30_000);

describe("GitHub project migration", () => {
  it("adds tenant-scoped installation/state tables and repository analysis fields", async () => {
    const sql = await readFile(migrations[2], "utf8");
    expect(sql).toContain("CREATE TABLE github_installations");
    expect(sql).toContain("installation_id bigint NOT NULL UNIQUE");
    expect(sql).toContain("CREATE TABLE github_installation_states");
    expect(sql).toContain("ALTER TABLE github_installations ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("ALTER TABLE github_installation_states ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("github_full_name");
    expect(sql).toContain("default_branch");
    expect(sql).toContain("last_analyzed_commit_sha");
    expect(sql).toContain("analysis_report");
  });
});

describe.skipIf(!baseDatabaseUrl)("GitHub project tenant security", () => {
  it("refuses to bind one GitHub installation to two organizations", async () => {
    const databaseUrl = databaseUrlFor(integrationDb);
    await psql(databaseUrl, `INSERT INTO github_installations (organization_id, installation_id, connected_by_user_id) VALUES ('${org1}', 81234, '${user1}');`);
    expect(await fails(databaseUrl, `INSERT INTO github_installations (organization_id, installation_id, connected_by_user_id) VALUES ('${org2}', 81234, '${user2}');`)).toBe(true);
  });

  it("keeps installation/state visibility tenant scoped", async () => {
    const databaseUrl = databaseUrlFor(integrationDb);
    await psql(databaseUrl, `INSERT INTO github_installation_states (id, organization_id, user_id, expires_at) VALUES ('90000000-0000-4000-8000-000000000081', '${org1}', '${user1}', now() + interval '10 minutes');`);
    const visible = await psql(databaseUrl, `BEGIN; SET LOCAL ROLE coding_agent_app; SELECT set_config('app.organization_id','${org2}',true); SELECT count(*) FROM github_installation_states; COMMIT;`);
    expect(visible.split("\n").at(-1)).toBe("0");
  });

  it("persists a full analyzed commit SHA and deterministic report on the repository", async () => {
    const databaseUrl = databaseUrlFor(integrationDb);
    const project = "20000000-0000-4000-8000-000000000081";
    const repository = "30000000-0000-4000-8000-000000000081";
    const sha = "a".repeat(40);
    await psql(databaseUrl, `
      INSERT INTO projects (id, organization_id, name) VALUES ('${project}', '${org1}', 'repo');
      INSERT INTO repositories (id, organization_id, project_id, provider, external_id, display_name, github_full_name, default_branch, last_analyzed_commit_sha, analysis_report)
      VALUES ('${repository}', '${org1}', '${project}', 'github', '9981', 'repo', 'acme/repo', 'main', '${sha}', '{"stackSkill":"typescript-node"}'::jsonb);
    `);
    expect(await psql(databaseUrl, `SELECT default_branch || ',' || last_analyzed_commit_sha || ',' || analysis_report->>'stackSkill' FROM repositories WHERE id='${repository}';`)).toBe(`main,${sha},typescript-node`);
    expect(await fails(databaseUrl, `UPDATE repositories SET last_analyzed_commit_sha='short' WHERE id='${repository}';`)).toBe(true);
  });
});

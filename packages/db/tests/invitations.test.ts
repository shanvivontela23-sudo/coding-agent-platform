import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const baseDatabaseUrl = process.env.TEST_DATABASE_URL;
const integrationDb = "coding_agent_invite_security";
const migration1 = "packages/db/migrations/0001_tenant_core.sql";
const migration2 = "packages/db/migrations/0002_organization_invitations.sql";

const org = "00000000-0000-4000-8000-000000000051";
const owner = "10000000-0000-4000-8000-000000000051";
const ownerSupabase = "60000000-0000-4000-8000-000000000051";
const invite = "70000000-0000-4000-8000-000000000051";
const inviteSupabase = "60000000-0000-4000-8000-000000000052";

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
  await execFileAsync("psql", [databaseUrl, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", migration1], { encoding: "utf8" });
  await execFileAsync("psql", [databaseUrl, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", migration2], { encoding: "utf8" });
  await psql(databaseUrl, `
    INSERT INTO organizations (id, name) VALUES ('${org}', 'Acme');
    INSERT INTO users (id, supabase_user_id, email) VALUES ('${owner}', '${ownerSupabase}', 'owner@example.com');
    INSERT INTO organization_memberships (organization_id, user_id, role) VALUES ('${org}', '${owner}', 'owner');
    INSERT INTO organization_invitations (id, organization_id, email, role, invited_by_user_id)
    VALUES ('${invite}', '${org}', 'invitee@example.com', 'developer', '${owner}');
  `);
}, 30_000);

afterAll(async () => {
  if (baseDatabaseUrl) await psql(baseDatabaseUrl, `DROP DATABASE IF EXISTS ${integrationDb} WITH (FORCE)`);
}, 30_000);

describe("organization invitations migration", () => {
  it("adds only the two narrow invitation SECURITY DEFINER functions", async () => {
    const sql = await readFile(migration2, "utf8");
    expect(sql).toContain("CREATE TABLE organization_invitations");
    expect(sql).toContain("role IN ('developer', 'rep')");
    expect(sql).toMatch(/expires_at timestamptz NOT NULL DEFAULT \(now\(\) \+ interval '7 days'\)/i);
    expect(sql).toContain("ALTER TABLE organization_invitations ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("ALTER TABLE organization_invitations FORCE ROW LEVEL SECURITY");
    expect(sql.match(/SECURITY DEFINER/g)).toHaveLength(2);
    expect(sql).toMatch(/FUNCTION public\.list_invitations_for_verified_email\(uuid, text, boolean\)[\s\S]*SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, public/i);
    expect(sql).toMatch(/FUNCTION public\.accept_invitation_for_verified_email\(uuid, text, boolean, uuid\)[\s\S]*SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, public/i);
    expect(sql).toContain("REVOKE ALL ON FUNCTION public.list_invitations_for_verified_email(uuid, text, boolean) FROM PUBLIC");
    expect(sql).toContain("REVOKE ALL ON FUNCTION public.accept_invitation_for_verified_email(uuid, text, boolean, uuid) FROM PUBLIC");
  });
});

describe.skipIf(!baseDatabaseUrl)("verified invitation security", () => {
  it("lists only unexpired invitations for a confirmed matching email", async () => {
    const databaseUrl = databaseUrlFor(integrationDb);
    const result = await psql(databaseUrl, `SET ROLE coding_agent_api; SELECT invitation_id || ',' || organization_id || ',' || role FROM public.list_invitations_for_verified_email('${inviteSupabase}', ' INVITEE@example.com ', true);`);
    expect(result).toBe(`${invite},${org},developer`);
    expect(await fails(databaseUrl, `SET ROLE coding_agent_api; SELECT * FROM public.list_invitations_for_verified_email('${inviteSupabase}', 'invitee@example.com', false);`)).toBe(true);
    expect(await psql(databaseUrl, `SET ROLE coding_agent_api; SELECT count(*) FROM public.list_invitations_for_verified_email('${inviteSupabase}', 'wrong@example.com', true);`)).toBe("0");
  });

  it("uses a seven-day server-side expiry and rejects owner invitations", async () => {
    const databaseUrl = databaseUrlFor(integrationDb);
    const hours = Number(await psql(databaseUrl, `SELECT extract(epoch FROM (expires_at - created_at))/3600 FROM organization_invitations WHERE id='${invite}';`));
    expect(hours).toBeGreaterThan(167.9);
    expect(hours).toBeLessThan(168.1);
    expect(await fails(databaseUrl, `INSERT INTO organization_invitations (id, organization_id, email, role, invited_by_user_id) VALUES ('70000000-0000-4000-8000-000000000059','${org}','owner2@example.com','owner','${owner}');`)).toBe(true);
  });

  it("accepts the specific matching invite once and blocks wrong email, unconfirmed identity and reuse", async () => {
    const databaseUrl = databaseUrlFor(integrationDb);
    expect(await fails(databaseUrl, `SET ROLE coding_agent_api; SELECT * FROM public.accept_invitation_for_verified_email('${inviteSupabase}', 'wrong@example.com', true, '${invite}');`)).toBe(true);
    expect(await fails(databaseUrl, `SET ROLE coding_agent_api; SELECT * FROM public.accept_invitation_for_verified_email('${inviteSupabase}', 'invitee@example.com', false, '${invite}');`)).toBe(true);

    const accepted = await psql(databaseUrl, `SET ROLE coding_agent_api; SELECT user_id || ',' || organization_id || ',' || role FROM public.accept_invitation_for_verified_email('${inviteSupabase}', 'invitee@example.com', true, '${invite}');`);
    const [acceptedUser, acceptedOrg, acceptedRole] = accepted.split(",");
    expect(acceptedOrg).toBe(org);
    expect(acceptedRole).toBe("developer");
    expect(await psql(databaseUrl, `SELECT count(*) FROM organization_memberships WHERE organization_id='${org}' AND user_id='${acceptedUser}' AND role='developer';`)).toBe("1");
    expect(await fails(databaseUrl, `SET ROLE coding_agent_api; SELECT * FROM public.accept_invitation_for_verified_email('${inviteSupabase}', 'invitee@example.com', true, '${invite}');`)).toBe(true);
  });
});

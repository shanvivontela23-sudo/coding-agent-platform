import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SessionIdentity } from "../src/auth.js";
import type { TenantPool } from "../src/database.js";
import { createOrganizationSkillDatabase } from "../src/organization-skill-database.js";
import { createOrganizationSkillService } from "../src/organization-skill-service.js";
import { testPool } from "./helpers/test-pool.js";

const baseDatabaseUrl = process.env.TEST_DATABASE_URL;
const integrationDb = "coding_agent_organization_skills";
const apiPassword = "coding-agent-organization-skills-password";
const orgA = "00000000-0000-4000-8000-000000000515";
const orgB = "00000000-0000-4000-8000-000000000516";
const ownerA = "10000000-0000-4000-8000-000000000515";
const repA = "10000000-0000-4000-8000-000000000516";
const ownerB = "10000000-0000-4000-8000-000000000517";
let rootPool: Pool | null = null;
let adminPool: Pool | null = null;
let apiPool: Pool | null = null;
const session = (organizationId: string, userId: string): SessionIdentity => ({ organizationId, userId, expiresAtMs: Date.now() + 60_000 });

function databaseUrlFor(name: string, user?: string, password?: string): string {
  const url = new URL(baseDatabaseUrl!);
  url.pathname = `/${name}`;
  if (user) url.username = user;
  if (password) url.password = password;
  return url.toString();
}

beforeAll(async () => {
  if (!baseDatabaseUrl) return;
  rootPool = testPool({ connectionString: baseDatabaseUrl });
  await rootPool.query(`DROP DATABASE IF EXISTS ${integrationDb} WITH (FORCE)`);
  await rootPool.query(`CREATE DATABASE ${integrationDb}`);
  adminPool = testPool({ connectionString: databaseUrlFor(integrationDb) });
  for (const name of (await readdir("packages/db/migrations")).filter((file) => /^\d{4}_.+\.sql$/.test(file)).sort()) {
    await adminPool.query(await readFile(join("packages/db/migrations", name), "utf8"));
  }
  await adminPool.query(`ALTER ROLE coding_agent_api PASSWORD '${apiPassword}'`);
  await adminPool.query(`
    INSERT INTO organizations (id,name) VALUES ('${orgA}','Acme'),('${orgB}','Other');
    INSERT INTO users (id,supabase_user_id,email) VALUES
      ('${ownerA}','60000000-0000-4000-8000-000000000515','owner@acme.test'),
      ('${repA}','60000000-0000-4000-8000-000000000516','rep@acme.test'),
      ('${ownerB}','60000000-0000-4000-8000-000000000517','owner@other.test');
    INSERT INTO organization_memberships (organization_id,user_id,role) VALUES
      ('${orgA}','${ownerA}','owner'),('${orgA}','${repA}','rep'),('${orgB}','${ownerB}','owner');
  `);
  apiPool = testPool({ connectionString: databaseUrlFor(integrationDb, "coding_agent_api", apiPassword), max: 4 });
}, 60_000);

afterAll(async () => {
  await apiPool?.end();
  await adminPool?.end();
  if (rootPool) await rootPool.query(`DROP DATABASE IF EXISTS ${integrationDb} WITH (FORCE)`);
  await rootPool?.end();
}, 30_000);

describe.skipIf(!baseDatabaseUrl)("organization rules in Postgres", () => {
  it("lets the owner manage rules, lets members read them, and isolates organizations", async () => {
    const database = createOrganizationSkillDatabase(apiPool as unknown as TenantPool);
    const service = createOrganizationSkillService({ database });

    await service.create(session(orgA, ownerA), { title: "Update the changelog", body: "Every PR adds a CHANGELOG.md line.", appliesToStacks: null });
    await service.create(session(orgA, ownerA), { title: "Use pytest fixtures", body: "Reuse conftest fixtures.", appliesToStacks: ["python"] });
    await expect(service.create(session(orgA, repA), { title: "Nope", body: "Reps cannot add rules.", appliesToStacks: null })).rejects.toMatchObject({ code: "ORGANIZATION_RULE_FORBIDDEN", status: 403 });
    await expect(service.create(session(orgA, ownerA), { title: "Bad", body: "Unknown stack", appliesToStacks: ["cobol"] })).rejects.toMatchObject({ code: "ORGANIZATION_RULE_INVALID" });

    const repView = await service.view(session(orgA, repA));
    expect(repView).toMatchObject({ organization: { name: "Acme" }, currentUser: { email: "rep@acme.test", role: "rep" } });
    expect(repView.rules.map((rule) => [rule.title, rule.appliesToStacks])).toEqual([["Update the changelog", null], ["Use pytest fixtures", ["python"]]]);
    expect(repView.limits.enabledChars).toBeGreaterThan(0);

    const otherView = await service.view(session(orgB, ownerB));
    expect(otherView.rules).toEqual([]);
    const [first, second] = repView.rules;
    await expect(service.setEnabled(session(orgB, ownerB), first!.id, false)).rejects.toMatchObject({ code: "ORGANIZATION_RULE_NOT_FOUND" });
    await expect(service.remove(session(orgB, ownerB), first!.id)).rejects.toMatchObject({ code: "ORGANIZATION_RULE_NOT_FOUND" });

    await service.update(session(orgA, ownerA), first!.id, { title: "Changelog", body: "Every PR adds one CHANGELOG.md line.", appliesToStacks: ["typescript-node", "python"] });
    await service.setEnabled(session(orgA, ownerA), second!.id, false);
    await service.remove(session(orgA, ownerA), second!.id);
    const after = await service.view(session(orgA, ownerA));
    expect(after.rules.map((rule) => [rule.title, rule.appliesToStacks, rule.enabled])).toEqual([["Changelog", ["typescript-node", "python"], true]]);

    const audit = await adminPool!.query<{ event_type: string }>(`SELECT event_type FROM audit_events WHERE organization_id=$1 ORDER BY created_at`, [orgA]);
    expect(audit.rows.map((row) => row.event_type)).toEqual(["organization_rule_created", "organization_rule_created", "organization_rule_updated", "organization_rule_deleted"]);
  });

  it("enforces size and stack-format limits in the database itself", async () => {
    const insert = (title: string, body: string, stacks: string) => adminPool!.query(`INSERT INTO organization_skills (id,organization_id,title,body,applies_to_stacks) VALUES (gen_random_uuid(),$1,$2,$3,${stacks})`, [orgA, title, body]);
    await expect(insert("t", "x".repeat(2_001), "NULL")).rejects.toThrow();
    await expect(insert("", "b", "NULL")).rejects.toThrow();
    await expect(insert("t", "b", "ARRAY['Bad Stack']")).rejects.toThrow();
    await expect(insert("t", "b", "ARRAY[]::text[]")).rejects.toThrow();
    await expect(insert("t", "b", "ARRAY['python','java-spring']")).resolves.toBeDefined();
  });
});

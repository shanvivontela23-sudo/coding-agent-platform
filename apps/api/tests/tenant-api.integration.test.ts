import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSessionToken } from "../src/auth.js";
import { createProductDatabase, withTenant } from "../src/database.js";
import { createApiServer } from "../src/server.js";

const baseDatabaseUrl = process.env.TEST_DATABASE_URL;
const integrationDb = "coding_agent_api_integration";
const apiPassword = "coding-agent-api-integration-password";
const sessionSecret = "test-session-secret-that-is-long-enough";
const orgA = "00000000-0000-4000-8000-000000000011";
const orgB = "00000000-0000-4000-8000-000000000012";
const userA = "10000000-0000-4000-8000-000000000011";
const userB = "10000000-0000-4000-8000-000000000012";
const supabaseA = "60000000-0000-4000-8000-000000000011";
const supabaseB = "60000000-0000-4000-8000-000000000012";
const projectA = "20000000-0000-4000-8000-000000000011";
const projectB = "20000000-0000-4000-8000-000000000012";

let rootPool: Pool | null = null;
let adminPool: Pool | null = null;
let apiPool: Pool | null = null;

function databaseUrlFor(name: string, user?: string, password?: string): string {
  const url = new URL(baseDatabaseUrl!);
  url.pathname = `/${name}`;
  if (user) url.username = user;
  if (password) url.password = password;
  return url.toString();
}

beforeAll(async () => {
  if (!baseDatabaseUrl) return;
  rootPool = new Pool({ connectionString: baseDatabaseUrl });
  await rootPool.query(`DROP DATABASE IF EXISTS ${integrationDb} WITH (FORCE)`);
  await rootPool.query(`CREATE DATABASE ${integrationDb}`);

  adminPool = new Pool({ connectionString: databaseUrlFor(integrationDb) });
  for (const name of ["0001_tenant_core.sql", "0002_organization_invitations.sql", "0003_github_projects.sql", "0004_task_intake.sql", "0005_zip_projects_and_task_review_fixes.sql"]) {
    await adminPool.query(await readFile(`packages/db/migrations/${name}`, "utf8"));
  }
  await adminPool.query(`ALTER ROLE coding_agent_api PASSWORD '${apiPassword}'`);
  await adminPool.query(`
    INSERT INTO organizations (id,name) VALUES ('${orgA}','Tenant A'),('${orgB}','Tenant B');
    INSERT INTO users (id,supabase_user_id,email) VALUES
      ('${userA}','${supabaseA}','a@example.com'),
      ('${userB}','${supabaseB}','b@example.com');
    INSERT INTO organization_memberships (organization_id,user_id,role) VALUES
      ('${orgA}','${userA}','owner'),
      ('${orgB}','${userB}','owner');
    INSERT INTO projects (id,organization_id,name) VALUES
      ('${projectA}','${orgA}','A project'),
      ('${projectB}','${orgB}','B secret project');
  `);

  apiPool = new Pool({ connectionString: databaseUrlFor(integrationDb, "coding_agent_api", apiPassword), max: 1 });
}, 30_000);

afterAll(async () => {
  await apiPool?.end();
  await adminPool?.end();
  if (rootPool) {
    await rootPool.query(`DROP DATABASE IF EXISTS ${integrationDb} WITH (FORCE)`);
    await rootPool.end();
  }
}, 30_000);

describe.skipIf(!baseDatabaseUrl)("restricted tenant API integration", () => {
  it("a failed tenant transaction leaves no role or tenant setting on the pooled connection", async () => {
    const pool = apiPool!;
    await expect(withTenant(pool, { organizationId: orgA }, async (database) => {
      await database.query("SELECT count(*) FROM projects");
      throw new Error("force rollback");
    })).rejects.toThrow("force rollback");

    const client = await pool.connect();
    try {
      const result = await client.query<{ current_user: string; organization_id: string | null }>(
        "SELECT current_user, NULLIF(current_setting('app.organization_id', true), '') AS organization_id",
      );
      expect(result.rows[0]).toEqual({ current_user: "coding_agent_api", organization_id: null });
    } finally {
      client.release();
    }
  });

  it("starts the real API as coding_agent_api and tenant A cannot read tenant B projects", async () => {
    const database = createProductDatabase(apiPool!);
    const server = createApiServer({
      webOrigin: "http://localhost:3000",
      apiOrigin: "http://localhost:3001",
      sessionSecret,
      sessionDurationMs: 60_000,
      onboardingDurationMs: 600_000,
      auth: {
        signInWithPassword: async () => ({ supabaseUserId: supabaseA, email: "a@example.com", provider: "email" }),
        startGitHubOAuth: () => ({ authorizationUrl: "https://example.invalid", flowId: "flow", flowCookie: "cookie" }),
        completeGitHubOAuth: async () => ({ supabaseUserId: supabaseA, email: "a@example.com", provider: "github" }),
      },
      database,
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    try {
      const token = createSessionToken({ userId: userA, organizationId: orgA, expiresAtMs: Date.now() + 60_000 }, sessionSecret);
      const response = await fetch(`http://127.0.0.1:${address.port}/api/home`, {
        headers: { cookie: `tenant_session=${encodeURIComponent(token)}` },
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        organization: { id: orgA, name: "Tenant A" },
        user: { id: userA, email: "a@example.com" },
        projects: [{ id: projectA, name: "A project", source: null }],
        github: null,
      });
    } finally {
      server.close();
      await once(server, "close");
    }
  });
});
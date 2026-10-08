import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSessionToken } from "../src/auth.js";
import { createProductDatabase } from "../src/database.js";
import type { GitHubAppClient } from "../src/github-app.js";
import { createApiServer } from "../src/server.js";
import { createTaskDatabase } from "../src/task-database.js";
import { attachTaskRoutes } from "../src/task-server.js";
import { createTaskReadService } from "../src/task-service.js";
import { createTicketCipher } from "../src/ticket-crypto.js";

const baseDatabaseUrl = process.env.TEST_DATABASE_URL;
const integrationDb = "coding_agent_task_read_http";
const apiPassword = "coding-agent-task-read-http-password";
const sessionSecret = "task-read-http-session-secret-that-is-long-enough";
const organizationId = "00000000-0000-4000-8000-000000000096";
const userId = "10000000-0000-4000-8000-000000000096";
const supabaseUserId = "60000000-0000-4000-8000-000000000096";

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
    await adminPool.query(await readFile(join("packages/db/migrations", name), "utf8"));
  }
  await adminPool.query(`ALTER ROLE coding_agent_api PASSWORD '${apiPassword}'`);
  await adminPool.query(`
    INSERT INTO organizations (id,name) VALUES ('${organizationId}','Task Read HTTP');
    INSERT INTO users (id,supabase_user_id,email) VALUES ('${userId}','${supabaseUserId}','owner@example.com');
    INSERT INTO organization_memberships (organization_id,user_id,role) VALUES ('${organizationId}','${userId}','owner');
  `);
  apiPool = new Pool({ connectionString: databaseUrlFor(integrationDb, "coding_agent_api", apiPassword), max: 2 });
}, 30_000);

afterAll(async () => {
  await apiPool?.end();
  await adminPool?.end();
  if (rootPool) {
    await rootPool.query(`DROP DATABASE IF EXISTS ${integrationDb} WITH (FORCE)`);
    await rootPool.end();
  }
}, 30_000);

describe.skipIf(!baseDatabaseUrl)("task read HTTP routes without model gateway", () => {
  it("serves configuration and task list through the restricted database role", async () => {
    const database = createProductDatabase(apiPool!);
    const taskDatabase = createTaskDatabase(apiPool!);
    const readService = createTaskReadService({ database: taskDatabase, cipher: createTicketCipher(sessionSecret) });
    const githubApp = {
      installationUrl() { throw new Error("not used"); },
      async verifyUserInstallation() { throw new Error("not used"); },
      async getInstallationDetails() { throw new Error("not used"); },
      async listRepositories() { throw new Error("not used"); },
      async analyseRepository() { throw new Error("not used"); },
      async checkInstallation() { throw new Error("not used"); },
    } as unknown as GitHubAppClient;
    const productServer = createApiServer({
      webOrigin: "http://localhost:3000",
      apiOrigin: "http://localhost:3001",
      sessionSecret,
      sessionDurationMs: 60_000,
      onboardingDurationMs: 60_000,
      auth: {
        async signInWithPassword() { throw new Error("not used"); },
        startGitHubOAuth() { throw new Error("not used"); },
        async completeGitHubOAuth() { throw new Error("not used"); },
      },
      database,
      githubApp,
    });
    const server = attachTaskRoutes(productServer, {
      apiOrigin: "http://localhost:3001",
      webOrigin: "http://localhost:3000",
      sessionSecret,
      readService,
      planningService: undefined,
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const token = createSessionToken({ userId, organizationId, expiresAtMs: Date.now() + 60_000 }, sessionSecret);
    const headers = { cookie: `tenant_session=${encodeURIComponent(token)}` };

    try {
      const configuration = await fetch(`http://127.0.0.1:${address.port}/api/tasks/configuration`, { headers });
      expect(configuration.status).toBe(200);
      expect(await configuration.json()).toEqual({ planningConfigured: false });

      const tasks = await fetch(`http://127.0.0.1:${address.port}/api/tasks`, { headers });
      expect(tasks.status).toBe(200);
      expect(await tasks.json()).toEqual({ tasks: [] });
    } finally {
      server.close();
      await once(server, "close");
    }
  }, 30_000);
});

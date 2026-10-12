import { once } from "node:events";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSessionToken } from "../src/auth.js";
import type { TenantPool } from "../src/database.js";
import { attachTaskExecutionRoutes } from "../src/task-execution-server.js";
import type { TaskExecutionService } from "../src/task-execution-service.js";
import { createTaskPublicationDatabase } from "../src/task-publication-database.js";
import { createTaskPublicationService } from "../src/task-publication-service.js";

const baseDatabaseUrl = process.env.TEST_DATABASE_URL;
const integrationDb = "coding_agent_publication_concurrency";
const apiPassword = "coding-agent-publication-concurrency-password";
const sessionSecret = "publication-concurrency-session-secret-long-enough";
const org = "00000000-0000-4000-8000-000000000741";
const user = "10000000-0000-4000-8000-000000000741";
const project = "20000000-0000-4000-8000-000000000741";
const repository = "30000000-0000-4000-8000-000000000741";
const task = "40000000-0000-4000-8000-000000000741";
const execution = "50000000-0000-4000-8000-000000000741";
const commit = "a".repeat(40);
let rootPool: Pool | null = null;
let adminPool: Pool | null = null;
let apiPool: Pool | null = null;

function databaseUrlFor(name: string, username?: string, password?: string): string {
  const url = new URL(baseDatabaseUrl!);
  url.pathname = `/${name}`;
  if (username) url.username = username;
  if (password) url.password = password;
  return url.toString();
}

beforeAll(async () => {
  if (!baseDatabaseUrl) return;
  rootPool = new Pool({ connectionString: baseDatabaseUrl });
  await rootPool.query(`DROP DATABASE IF EXISTS ${integrationDb} WITH (FORCE)`);
  await rootPool.query(`CREATE DATABASE ${integrationDb}`);
  adminPool = new Pool({ connectionString: databaseUrlFor(integrationDb) });
  for (const name of ["0001_tenant_core.sql", "0002_organization_invitations.sql", "0003_github_projects.sql", "0004_task_intake.sql", "0005_zip_projects_and_task_review_fixes.sql", "0006_task_execution.sql", "0007_task_execution_b2.sql", "0008_verification_incomplete.sql", "0009_github_publication.sql"]) {
    await adminPool.query(await readFile(join("packages/db/migrations", name), "utf8"));
  }
  await adminPool.query(`ALTER ROLE coding_agent_api PASSWORD '${apiPassword}'`);
  const patch = "diff --git a/src/a.ts b/src/a.ts\\n--- a/src/a.ts\\n+++ b/src/a.ts\\n@@ -1 +1 @@\\n-old\\n+new\\n";
  const metadata = JSON.stringify({ verifiedFiles: [{ path: "src/a.ts", blobSha: "d".repeat(40), mode: "100644", deleted: false }] }).replaceAll("'", "''");
  await adminPool.query(`
    INSERT INTO organizations (id,name) VALUES ('${org}','Publication Concurrency');
    INSERT INTO users (id,supabase_user_id,email) VALUES ('${user}','60000000-0000-4000-8000-000000000741','dev@example.com');
    INSERT INTO organization_memberships (organization_id,user_id,role) VALUES ('${org}','${user}','developer');
    INSERT INTO projects (id,organization_id,name) VALUES ('${project}','${org}','Demo');
    INSERT INTO repositories (id,organization_id,project_id,provider,external_id,display_name,github_repository_id,full_name,default_branch)
      VALUES ('${repository}','${org}','${project}','github','741','acme/demo',741,'acme/demo','main');
    INSERT INTO github_installations (organization_id,installation_id,connected_by_user_id,status) VALUES ('${org}',777,'${user}','connected');
    INSERT INTO project_reports (organization_id,project_id,report,analysed_commit) VALUES ('${org}','${project}','{"installCommand":"npm ci"}'::jsonb,'${commit}');
    INSERT INTO tasks (id,organization_id,project_id,repository_id,requested_by_user_id,status,requirement,task_model_budget_usd)
      VALUES ('${task}','${org}','${project}','${repository}','${user}','draft','Fix A',0.50);
    UPDATE tasks SET status='plan_ready',what_i_understand='Fix A',proposed_approach='Update src/a.ts' WHERE id='${task}';
    UPDATE tasks SET status='approved',confirmed_requirement='Fix A',confirmed_plan='Update src/a.ts',approved_at=now() WHERE id='${task}';
    INSERT INTO task_executions (id,organization_id,task_id,project_id,attempt,started_by_user_id,source_commit_sha,budget_usd,timeout_seconds,status,finished_at,result_patch,change_document,result_metadata)
      VALUES ('${execution}','${org}','${task}','${project}',1,'${user}','${commit}',1.00,600,'succeeded',now(),E'${patch.replaceAll("'", "''")}','## What was asked','${metadata}'::jsonb);
  `);
  apiPool = new Pool({ connectionString: databaseUrlFor(integrationDb, "coding_agent_api", apiPassword), max: 4 });
}, 30_000);

afterAll(async () => {
  await apiPool?.end();
  await adminPool?.end();
  if (rootPool) { await rootPool.query(`DROP DATABASE IF EXISTS ${integrationDb} WITH (FORCE)`); await rootPool.end(); }
}, 30_000);

describe.skipIf(!baseDatabaseUrl)("concurrent GitHub publication", () => {
  it("lets exactly one request publish and returns 409 with the current record to the other", async () => {
    let releasePublish!: () => void;
    let enteredPublish!: () => void;
    const entered = new Promise<void>((resolve) => { enteredPublish = resolve; });
    const release = new Promise<void>((resolve) => { releasePublish = resolve; });
    const publisher = {
      publish: vi.fn(async () => {
        enteredPublish();
        await release;
        return { status: "published" as const, branchName: `dhara/execution-${execution}`, baseMovedCommits: 0, currentHeadSha: commit, branchHeadSha: "b".repeat(40), pullRequestNumber: 17, pullRequestUrl: "https://github.com/acme/demo/pull/17" };
      }),
    };
    const publicationService = createTaskPublicationService({
      database: createTaskPublicationDatabase(apiPool! as unknown as TenantPool),
      publisher,
      githubApp: { async getInstallationPermissions() { return { contents: "write" as const }; } },
    });
    const executionService = {
      async get() { return null; }, async readiness() { return { implementationBlocker: null }; },
      async start() { throw new Error("not used"); }, async cancel() { throw new Error("not used"); },
    } as unknown as TaskExecutionService;
    const base = createServer((_request, response) => { response.statusCode = 404; response.end("not found"); });
    const server = attachTaskExecutionRoutes(base, { apiOrigin: "http://localhost:3001", sessionSecret, service: executionService, publicationService });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const token = createSessionToken({ userId: user, organizationId: org, expiresAtMs: Date.now() + 60_000 }, sessionSecret);
    const endpoint = `http://127.0.0.1:${address.port}/api/tasks/${task}/execution/publication`;
    const options = { method: "POST", headers: { cookie: `tenant_session=${encodeURIComponent(token)}` } };
    try {
      const firstPromise = fetch(endpoint, options);
      await entered;
      const second = await fetch(endpoint, options);
      expect(second.status).toBe(409);
      const secondBody = await second.json() as { code: string; error: string; publication: { status: string; executionId: string } };
      expect(secondBody).toMatchObject({ code: "TASK_PUBLICATION_IN_PROGRESS", error: "Publishing is already in progress", publication: { status: "publishing", executionId: execution } });
      releasePublish();
      const first = await firstPromise;
      expect(first.status).toBe(200);
      expect(publisher.publish).toHaveBeenCalledTimes(1);
    } finally {
      releasePublish();
      server.close();
      await once(server, "close");
    }
  }, 30_000);
});

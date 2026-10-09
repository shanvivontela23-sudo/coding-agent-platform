import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeCodingRunner } from "../../worker/src/fake-coding-runner.js";
import { PostgresExecutionQueue, type RestrictedQueryPool } from "../../worker/src/postgres-execution-queue.js";
import { runExecutionWorkerOnce } from "../../worker/src/task-execution-worker.js";
import { createSessionToken } from "../src/auth.js";
import { createProductDatabase } from "../src/database.js";
import type { GitHubAppClient } from "../src/github-app.js";
import { createApiServer } from "../src/server.js";
import { createTaskExecutionDatabase } from "../src/task-execution-database.js";
import { attachTaskExecutionRoutes } from "../src/task-execution-server.js";
import { createTaskExecutionService } from "../src/task-execution-service.js";

const baseDatabaseUrl = process.env.TEST_DATABASE_URL;
const integrationDb = "coding_agent_task_execution_http";
const apiPassword = "coding-agent-task-execution-http-password";
const sessionSecret = "task-execution-http-session-secret-long-enough";
const organizationId = "00000000-0000-4000-8000-000000000131";
const ownerId = "10000000-0000-4000-8000-000000000131";
const requesterId = "10000000-0000-4000-8000-000000000132";
const otherRepId = "10000000-0000-4000-8000-000000000133";
const projectId = "20000000-0000-4000-8000-000000000131";
const taskId = "40000000-0000-4000-8000-000000000131";
const commit = "b".repeat(40);
let rootPool: Pool | null = null;
let adminPool: Pool | null = null;
let apiPool: Pool | null = null;

function databaseUrlFor(name: string, user?: string, password?: string): string {
  const url = new URL(baseDatabaseUrl!); url.pathname = `/${name}`; if (user) url.username = user; if (password) url.password = password; return url.toString();
}

beforeAll(async () => {
  if (!baseDatabaseUrl) return;
  rootPool = new Pool({ connectionString: baseDatabaseUrl });
  await rootPool.query(`DROP DATABASE IF EXISTS ${integrationDb} WITH (FORCE)`);
  await rootPool.query(`CREATE DATABASE ${integrationDb}`);
  adminPool = new Pool({ connectionString: databaseUrlFor(integrationDb) });
  for (const name of ["0001_tenant_core.sql", "0002_organization_invitations.sql", "0003_github_projects.sql", "0004_task_intake.sql", "0005_zip_projects_and_task_review_fixes.sql", "0006_task_execution.sql"]) {
    await adminPool.query(await readFile(join("packages/db/migrations", name), "utf8"));
  }
  await adminPool.query(`ALTER ROLE coding_agent_api PASSWORD '${apiPassword}'`);
  await adminPool.query(`
    INSERT INTO organizations (id,name) VALUES ('${organizationId}','Execution HTTP');
    INSERT INTO users (id,supabase_user_id,email) VALUES
      ('${ownerId}','60000000-0000-4000-8000-000000000131','owner@example.com'),
      ('${requesterId}','60000000-0000-4000-8000-000000000132','requester@example.com'),
      ('${otherRepId}','60000000-0000-4000-8000-000000000133','other@example.com');
    INSERT INTO organization_memberships (organization_id,user_id,role) VALUES
      ('${organizationId}','${ownerId}','owner'),
      ('${organizationId}','${requesterId}','rep'),
      ('${organizationId}','${otherRepId}','rep');
    INSERT INTO projects (id,organization_id,name) VALUES ('${projectId}','${organizationId}','Demo');
    INSERT INTO project_reports (organization_id,project_id,report,analysed_commit) VALUES ('${organizationId}','${projectId}','{}'::jsonb,'${commit}');
    INSERT INTO tasks (id,organization_id,project_id,requested_by_user_id,status,requirement,task_model_budget_usd)
      VALUES ('${taskId}','${organizationId}','${projectId}','${requesterId}','draft','Fix retry',0.50);
    UPDATE tasks SET status='plan_ready', what_i_understand='Fix retry', proposed_approach='Update behavior' WHERE id='${taskId}';
    UPDATE tasks SET status='approved', confirmed_requirement='Fix retry', confirmed_plan='Update behavior', approved_at=now() WHERE id='${taskId}';
  `);
  apiPool = new Pool({ connectionString: databaseUrlFor(integrationDb, "coding_agent_api", apiPassword), max: 4 });
}, 30_000);

afterAll(async () => {
  await apiPool?.end(); await adminPool?.end();
  if (rootPool) { await rootPool.query(`DROP DATABASE IF EXISTS ${integrationDb} WITH (FORCE)`); await rootPool.end(); }
}, 30_000);

const githubApp = { async checkInstallation() { return undefined; } } as unknown as GitHubAppClient;

describe.skipIf(!baseDatabaseUrl)("task execution HTTP controls", () => {
  it("starts idempotently, runs the fake worker, and creates separate later attempts", async () => {
    const database = createProductDatabase(apiPool!);
    const service = createTaskExecutionService({ database: createTaskExecutionDatabase(apiPool!), budgetUsd: 1.25, timeoutSeconds: 900 });
    const base = createApiServer({ webOrigin: "http://localhost:3000", apiOrigin: "http://localhost:3001", sessionSecret, sessionDurationMs: 60_000, onboardingDurationMs: 60_000, auth: { async signInWithPassword() { throw new Error("not used"); }, startGitHubOAuth() { throw new Error("not used"); }, async completeGitHubOAuth() { throw new Error("not used"); } }, database, githubApp });
    const server = attachTaskExecutionRoutes(base, { apiOrigin: "http://localhost:3001", sessionSecret, service });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw new Error("server did not bind");
    const ownerToken = createSessionToken({ userId: ownerId, organizationId, expiresAtMs: Date.now() + 60_000 }, sessionSecret);
    const ownerHeaders = { cookie: `tenant_session=${encodeURIComponent(ownerToken)}` };
    const endpoint = `http://127.0.0.1:${address.port}/api/tasks/${taskId}/execution`;
    try {
      expect(await (await fetch(endpoint, { headers: ownerHeaders })).json()).toEqual({ execution: null });
      const first = await fetch(`${endpoint}/start`, { method: "POST", headers: ownerHeaders });
      expect(first.status).toBe(201);
      const firstPayload = await first.json() as { execution: { id: string; attempt: number; status: string; budgetUsd: number; timeoutSeconds: number }; created: boolean };
      expect(firstPayload.created).toBe(true); expect(firstPayload.execution).toMatchObject({ attempt: 1, status: "queued", budgetUsd: 1.25, timeoutSeconds: 900 });
      const duplicate = await fetch(`${endpoint}/start`, { method: "POST", headers: ownerHeaders });
      const duplicatePayload = await duplicate.json() as typeof firstPayload;
      expect(duplicate.status).toBe(200); expect(duplicatePayload.created).toBe(false); expect(duplicatePayload.execution.id).toBe(firstPayload.execution.id);

      const workerResult = await runExecutionWorkerOnce({
        queue: new PostgresExecutionQueue(apiPool! as unknown as RestrictedQueryPool),
        runner: new FakeCodingRunner(),
        workerId: "integration-worker",
        leaseSeconds: 30,
      });
      expect(workerResult).toEqual({ worked: true, executionId: firstPayload.execution.id, status: "succeeded" });
      expect(await (await fetch(endpoint, { headers: ownerHeaders })).json()).toMatchObject({ execution: { id: firstPayload.execution.id, status: "succeeded", attempt: 1 } });

      const second = await fetch(`${endpoint}/start`, { method: "POST", headers: ownerHeaders });
      const secondPayload = await second.json() as typeof firstPayload;
      expect(second.status).toBe(201); expect(secondPayload.execution.attempt).toBe(2); expect(secondPayload.execution.id).not.toBe(firstPayload.execution.id);
      const cancelled = await fetch(`${endpoint}/cancel`, { method: "POST", headers: ownerHeaders });
      expect((await cancelled.json() as { execution: { status: string } }).execution.status).toBe("cancelled");

      const requesterToken = createSessionToken({ userId: requesterId, organizationId, expiresAtMs: Date.now() + 60_000 }, sessionSecret);
      const requesterHeaders = { cookie: `tenant_session=${encodeURIComponent(requesterToken)}` };
      const third = await fetch(`${endpoint}/start`, { method: "POST", headers: requesterHeaders });
      const thirdPayload = await third.json() as typeof firstPayload;
      expect(third.status).toBe(201); expect(thirdPayload.execution.attempt).toBe(3);
      const requesterCancel = await fetch(`${endpoint}/cancel`, { method: "POST", headers: requesterHeaders });
      expect((await requesterCancel.json() as { execution: { status: string } }).execution.status).toBe("cancelled");
    } finally { server.close(); await once(server, "close"); }
  }, 30_000);

  it("refuses a rep who does not own the task", async () => {
    const database = createProductDatabase(apiPool!);
    const service = createTaskExecutionService({ database: createTaskExecutionDatabase(apiPool!), budgetUsd: 1, timeoutSeconds: 600 });
    const base = createApiServer({ webOrigin: "http://localhost:3000", apiOrigin: "http://localhost:3001", sessionSecret, sessionDurationMs: 60_000, onboardingDurationMs: 60_000, auth: { async signInWithPassword() { throw new Error("not used"); }, startGitHubOAuth() { throw new Error("not used"); }, async completeGitHubOAuth() { throw new Error("not used"); } }, database, githubApp });
    const server = attachTaskExecutionRoutes(base, { apiOrigin: "http://localhost:3001", sessionSecret, service });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw new Error("server did not bind");
    const token = createSessionToken({ userId: otherRepId, organizationId, expiresAtMs: Date.now() + 60_000 }, sessionSecret);
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/tasks/${taskId}/execution/start`, { method: "POST", headers: { cookie: `tenant_session=${encodeURIComponent(token)}` } });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "TASK_EXECUTION_FORBIDDEN" });
    } finally { server.close(); await once(server, "close"); }
  }, 30_000);
});

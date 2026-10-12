import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HarnessRunOutcome, HarnessRunner } from "../../../evals/src/harness/types.js";
import type { SandboxCommand, SandboxCommandResult, SandboxCreateRequest, SandboxNetworkPhase, SandboxPatch, SandboxProvider, SandboxSession, SandboxSnapshot } from "../../../evals/src/sandbox/types.js";
import type { ExecutionGatewayControl } from "../../worker/src/execution-gateway.js";
import { ProductExecutionSourceProvider, type GitHubPinnedArchiveReader } from "../../worker/src/product-execution-source.js";
import { PostgresExecutionQueue, type RestrictedQueryPool } from "../../worker/src/postgres-execution-queue.js";
import { createRealProductExecutionRunner } from "../../worker/src/real-worker.js";
import { runExecutionWorkerOnce } from "../../worker/src/task-execution-worker.js";
import type { RealWorkerConfig } from "../../worker/src/worker-config.js";
import { createSessionToken } from "../src/auth.js";
import { createProductDatabase, type TenantPool } from "../src/database.js";
import type { GitHubAppClient } from "../src/github-app.js";
import type { ProjectStorage } from "../src/project-storage.js";
import { createApiServer } from "../src/server.js";
import { createTaskExecutionDatabase } from "../src/task-execution-database.js";
import { attachTaskExecutionRoutes } from "../src/task-execution-server.js";
import { createTaskExecutionService } from "../src/task-execution-service.js";

const baseDatabaseUrl = process.env.TEST_DATABASE_URL;
const integrationDb = "coding_agent_task_execution_http";
const apiPassword = "coding-agent-task-execution-http-password";
const workerPassword = "coding-agent-task-execution-worker-password";
const sessionSecret = "task-execution-http-session-secret-long-enough";
const organizationId = "00000000-0000-4000-8000-000000000131";
const ownerId = "10000000-0000-4000-8000-000000000131";
const requesterId = "10000000-0000-4000-8000-000000000132";
const otherRepId = "10000000-0000-4000-8000-000000000133";
const projectId = "20000000-0000-4000-8000-000000000131";
const repositoryId = "30000000-0000-4000-8000-000000000131";
const taskId = "40000000-0000-4000-8000-000000000131";
const commit = "b".repeat(40);
let rootPool: Pool | null = null;
let adminPool: Pool | null = null;
let apiPool: Pool | null = null;
let workerPool: Pool | null = null;

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
  for (const name of ["0001_tenant_core.sql", "0002_organization_invitations.sql", "0003_github_projects.sql", "0004_task_intake.sql", "0005_zip_projects_and_task_review_fixes.sql", "0006_task_execution.sql", "0007_task_execution_b2.sql"]) {
    await adminPool.query(await readFile(join("packages/db/migrations", name), "utf8"));
  }
  await adminPool.query(`ALTER ROLE coding_agent_api PASSWORD '${apiPassword}'`);
  await adminPool.query(`ALTER ROLE coding_agent_worker PASSWORD '${workerPassword}'`);
  const report = JSON.stringify({ languages: [], frameworks: [], packageManager: null, buildCommand: null, testCommand: "pnpm test", stackSkill: "typescript-node", manifests: [] });
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
    INSERT INTO repositories (id,organization_id,project_id,provider,external_id,display_name,github_repository_id,full_name,default_branch)
      VALUES ('${repositoryId}','${organizationId}','${projectId}','github','4242','acme/demo',4242,'acme/demo','main');
    INSERT INTO github_installations (organization_id,installation_id,connected_by_user_id,status)
      VALUES ('${organizationId}',777,'${ownerId}','connected');
    INSERT INTO project_reports (organization_id,project_id,report,analysed_commit)
      VALUES ('${organizationId}','${projectId}','${report.replaceAll("'", "''")}'::jsonb,'${commit}');
    INSERT INTO tasks (id,organization_id,project_id,repository_id,requested_by_user_id,status,requirement,task_model_budget_usd,job_type)
      VALUES ('${taskId}','${organizationId}','${projectId}','${repositoryId}','${requesterId}','draft','Fix retry',0.50,'bug_fix');
    UPDATE tasks SET status='plan_ready', what_i_understand='Fix retry', proposed_approach='Update behavior' WHERE id='${taskId}';
    UPDATE tasks SET status='approved', confirmed_requirement='Fix retry', confirmed_plan='Update behavior', approved_at=now() WHERE id='${taskId}';
  `);
  apiPool = new Pool({ connectionString: databaseUrlFor(integrationDb, "coding_agent_api", apiPassword), max: 4 });
  workerPool = new Pool({ connectionString: databaseUrlFor(integrationDb, "coding_agent_worker", workerPassword), max: 4 });
}, 30_000);

afterAll(async () => {
  await workerPool?.end();
  await apiPool?.end();
  await adminPool?.end();
  if (rootPool) {
    await rootPool.query(`DROP DATABASE IF EXISTS ${integrationDb}`);
    await rootPool.end();
  }
}, 30_000);

const githubApp = { async checkInstallation() { return undefined; } } as unknown as GitHubAppClient;
const patch = [
  "diff --git a/src/retry.ts b/src/retry.ts",
  "--- a/src/retry.ts",
  "+++ b/src/retry.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "diff --git /dev/null b/src/retry.test.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/retry.test.ts",
  "@@ -0,0 +1 @@",
  "+test('retry',()=>expect(retry()).toBe(true));",
  "",
].join("\n");

class IntegrationSandboxSession implements SandboxSession {
  readonly workspacePath = "/workspace/repo";
  readonly baselineCommitSha = commit;
  readonly phases: SandboxNetworkPhase[] = [];
  destroyed = false;
  constructor(readonly id: string) {}
  async exec(request: SandboxCommand): Promise<SandboxCommandResult> {
    if (request.command.startsWith("git apply")) return { exitCode: 0, stdout: "", stderr: "" };
    if (request.command === "pnpm test src/retry.test.ts") {
      return this.id.endsWith("-baseline")
        ? { exitCode: 1, stdout: "FAIL src/retry.test.ts > retry recovers", stderr: "AssertionError: expected false to be true" }
        : { exitCode: 0, stdout: "PASS src/retry.test.ts > retry recovers", stderr: "" };
    }
    if (request.command === "pnpm test") return { exitCode: 0, stdout: "PASS existing.test.ts", stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  }
  async readFile(): Promise<string> { return ""; }
  async writeFile(): Promise<void> {}
  async setNetworkPhase(phase: SandboxNetworkPhase): Promise<void> { this.phases.push(phase); }
  async exportPatch(): Promise<SandboxPatch> { return { patch: "", status: "" }; }
  async snapshot(): Promise<SandboxSnapshot> { return { id: `${this.id}-snapshot` }; }
  async destroy(): Promise<void> { this.destroyed = true; }
}

class IntegrationSandboxProvider implements SandboxProvider {
  readonly requests: SandboxCreateRequest[] = [];
  async create(request: SandboxCreateRequest): Promise<SandboxSession> {
    this.requests.push(request);
    return new IntegrationSandboxSession(request.taskId);
  }
}

class IntegrationHarness implements HarnessRunner {
  readonly name = "codex" as const;
  readonly version = "fake";
  calls = 0;
  async run(): Promise<HarnessRunOutcome> {
    this.calls += 1;
    return { status: "completed", limit: null, turnsUsed: 2, wallClockSeconds: 1, patch: { patch, status: " M src/retry.ts\n?? src/retry.test.ts" } };
  }
}

function fakeRealConfig(): RealWorkerConfig {
  return {
    databaseUrl: "postgresql://coding_agent_worker:fake@localhost/fake",
    workerId: "integration-worker",
    e2bApiKey: "fake-e2b",
    model: "fake-model",
    codexVersion: "fake",
    gatewayUrl: "http://fake-gateway/v1",
    runTokenSecret: "a".repeat(32),
    gatewayStoreDir: "/tmp/not-used-gateway",
    harnessCallStoreDir: "/tmp/not-used-calls",
    litellmGatewayUrl: "http://fake-litellm",
    litellmAdminToken: "fake-admin",
    githubAppId: "12345",
    githubAppPrivateKey: "fake-key",
    projectStorageRoot: "/tmp/not-used-storage",
  };
}

function productRunner() {
  const sandbox = new IntegrationSandboxProvider();
  const harness = new IntegrationHarness();
  const githubArchive = new Uint8Array([31, 139, 8, 0]);
  const github: GitHubPinnedArchiveReader = {
    async read(input) {
      expect(input).toMatchObject({ installationId: 777, repositoryFullName: "acme/demo", commitSha: commit });
      return { archive: githubArchive, sha256: createHash("sha256").update(githubArchive).digest("hex") };
    },
  };
  const storage = {
    async writeVersion() { throw new Error("not used"); },
    async readVersion() { throw new Error("not used"); },
    async deleteVersion() {},
  } as unknown as ProjectStorage;
  const sourceProvider = new ProductExecutionSourceProvider({
    pool: workerPool! as unknown as TenantPool,
    storage,
    github,
    zipLimits: { maxCompressedBytes: 1024, maxUncompressedBytes: 4096, maxFiles: 20, maxFileBytes: 1024, maxNestedArchiveDepth: 1 },
    maxGitHubArchiveBytes: 1024,
  });
  const openedBudgets: number[] = [];
  const gateway: ExecutionGatewayControl = {
    async open(execution) {
      openedBudgets.push(execution.budgetUsd);
      return {
        gatewayUrl: "http://fake-gateway/v1",
        runToken: `fake-${execution.executionId}`,
        model: "fake-model",
        async readCostUsd() { return 0.27; },
        async finish() {},
      };
    },
  };
  const orchestrator = createRealProductExecutionRunner({
    config: fakeRealConfig(),
    pool: workerPool! as unknown as RestrictedQueryPool & Partial<TenantPool>,
    sourceProvider,
    sandboxProvider: sandbox,
    harness,
    gateway,
    env: { TASK_EXECUTION_MAX_PATCH_FILES: "10", TASK_EXECUTION_MAX_PATCH_BYTES: "100000" },
  });
  return { orchestrator, harness, openedBudgets };
}

function makeServer(service: ReturnType<typeof createTaskExecutionService>) {
  const database = createProductDatabase(apiPool!);
  const base = createApiServer({
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
  return attachTaskExecutionRoutes(base, { apiOrigin: "http://localhost:3001", sessionSecret, service });
}

describe.skipIf(!baseDatabaseUrl)("task execution HTTP controls", () => {
  it("API start -> real worker composition with fake external systems -> persisted patch/checks/change note/cost", async () => {
    const service = createTaskExecutionService({ database: createTaskExecutionDatabase(apiPool!), budgetUsd: 1.25, timeoutSeconds: 900 });
    const server = makeServer(service);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const ownerToken = createSessionToken({ userId: ownerId, organizationId, expiresAtMs: Date.now() + 60_000 }, sessionSecret);
    const ownerHeaders = { cookie: `tenant_session=${encodeURIComponent(ownerToken)}` };
    const endpoint = `http://127.0.0.1:${address.port}/api/tasks/${taskId}/execution`;
    try {
      expect(await (await fetch(endpoint, { headers: ownerHeaders })).json()).toEqual({ execution: null });
      const first = await fetch(`${endpoint}/start`, { method: "POST", headers: ownerHeaders });
      expect(first.status).toBe(201);
      const firstPayload = await first.json() as { execution: { id: string; attempt: number; status: string; budgetUsd: number; timeoutSeconds: number }; created: boolean };
      expect(firstPayload.created).toBe(true);
      expect(firstPayload.execution).toMatchObject({ attempt: 1, status: "queued", budgetUsd: 1.25, timeoutSeconds: 900 });

      const duplicate = await fetch(`${endpoint}/start`, { method: "POST", headers: ownerHeaders });
      const duplicatePayload = await duplicate.json() as typeof firstPayload;
      expect(duplicate.status).toBe(200);
      expect(duplicatePayload.execution.id).toBe(firstPayload.execution.id);

      const product = productRunner();
      const workerResult = await runExecutionWorkerOnce({
        queue: new PostgresExecutionQueue(workerPool! as unknown as RestrictedQueryPool),
        runner: product.orchestrator,
        workerId: "integration-worker",
        leaseSeconds: 30,
      });
      expect(workerResult).toEqual({ worked: true, executionId: firstPayload.execution.id, status: "succeeded" });
      expect(product.openedBudgets).toEqual([1.25]);
      expect(product.harness.calls).toBe(1);

      const result = await (await fetch(endpoint, { headers: ownerHeaders })).json() as { execution: { status: string; resultPatch: string | null; changeDocument: string | null; costUsd: number | null } };
      expect(result.execution).toMatchObject({ status: "succeeded", costUsd: 0.27 });
      expect(result.execution.resultPatch).toContain("src/retry.test.ts");
      expect(result.execution.changeDocument).toContain("Fail-before/pass-after proof");
      expect(result.execution.changeDocument).toContain("$0.27");

      const persisted = await adminPool!.query<{ checks: string; artifacts: string }>(
        `SELECT (SELECT count(*)::text FROM task_execution_checks WHERE execution_id=$1) AS checks,
                (SELECT count(*)::text FROM task_execution_artifacts WHERE execution_id=$1) AS artifacts`,
        [firstPayload.execution.id],
      );
      expect(Number(persisted.rows[0]!.checks)).toBeGreaterThanOrEqual(2);
      expect(Number(persisted.rows[0]!.artifacts)).toBeGreaterThanOrEqual(2);

      const second = await fetch(`${endpoint}/start`, { method: "POST", headers: ownerHeaders });
      expect(second.status).toBe(201);
      const cancelled = await fetch(`${endpoint}/cancel`, { method: "POST", headers: ownerHeaders });
      expect((await cancelled.json() as { execution: { status: string } }).execution.status).toBe("cancelled");
    } finally {
      server.close();
      await once(server, "close");
    }
  }, 30_000);

  it("refuses a rep who does not own the task", async () => {
    const service = createTaskExecutionService({ database: createTaskExecutionDatabase(apiPool!), budgetUsd: 1, timeoutSeconds: 600 });
    const server = makeServer(service);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const token = createSessionToken({ userId: otherRepId, organizationId, expiresAtMs: Date.now() + 60_000 }, sessionSecret);
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/tasks/${taskId}/execution/start`, { method: "POST", headers: { cookie: `tenant_session=${encodeURIComponent(token)}` } });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "TASK_EXECUTION_FORBIDDEN" });
    } finally {
      server.close();
      await once(server, "close");
    }
  }, 30_000);
});

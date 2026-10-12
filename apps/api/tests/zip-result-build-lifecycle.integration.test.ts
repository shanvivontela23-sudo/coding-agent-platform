import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTaskZipResultDatabase } from "../src/task-zip-result-database.js";
import type { TenantPool } from "../src/database.js";
import { PostgresExecutionQueue, type RestrictedQueryPool } from "../../worker/src/postgres-execution-queue.js";
import { PostgresZipResultArtifactStore, PostgresZipResultBuildQueue } from "../../worker/src/postgres-zip-result-build-queue.js";
import { runZipResultBuildWorkerOnce } from "../../worker/src/zip-result-build-worker.js";

const baseDatabaseUrl = process.env.TEST_DATABASE_URL;
const databaseName = "coding_agent_zip_build_lifecycle";
const apiPassword = "coding-agent-zip-build-api-password";
const workerPassword = "coding-agent-zip-build-worker-password";
const org = "00000000-0000-4000-8000-000000000931";
const developer = "10000000-0000-4000-8000-000000000931";
const project = "20000000-0000-4000-8000-000000000931";
const repository = "30000000-0000-4000-8000-000000000931";
const task = "40000000-0000-4000-8000-000000000931";
const execution = "50000000-0000-4000-8000-000000000931";
const sourceVersion = "60000000-0000-4000-8000-000000000931";
const raceTask = "40000000-0000-4000-8000-000000000932";
const raceExecution = "50000000-0000-4000-8000-000000000932";
const staleTask = "40000000-0000-4000-8000-000000000933";
const staleExecution = "50000000-0000-4000-8000-000000000933";
let rootPool: Pool | null = null;
let adminPool: Pool | null = null;
let apiPool: Pool | null = null;
let workerPool: Pool | null = null;

function urlFor(name: string, username?: string, password?: string): string {
  const url = new URL(baseDatabaseUrl!); url.pathname = `/${name}`; if (username) url.username = username; if (password) url.password = password; return url.toString();
}

async function waitForDatabaseBackendsToClose(pool: Pool, name: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()",
      [name],
    );
    if (result.rows[0]?.count === "0") return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`database ${name} still has active test connections after pool shutdown`);
}

beforeAll(async () => {
  if (!baseDatabaseUrl) return;
  rootPool = new Pool({ connectionString: baseDatabaseUrl });
  await rootPool.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
  await rootPool.query(`CREATE DATABASE ${databaseName}`);
  adminPool = new Pool({ connectionString: urlFor(databaseName) });
  for (const name of ["0001_tenant_core.sql","0002_organization_invitations.sql","0003_github_projects.sql","0004_task_intake.sql","0005_zip_projects_and_task_review_fixes.sql","0006_task_execution.sql","0007_task_execution_b2.sql","0008_verification_incomplete.sql","0009_github_publication.sql","0010_zip_results.sql","0011_zip_result_build_lifecycle.sql"]) await adminPool.query(await readFile(join("packages/db/migrations", name), "utf8"));
  await adminPool.query(`ALTER ROLE coding_agent_api PASSWORD '${apiPassword}'`);
  await adminPool.query(`ALTER ROLE coding_agent_worker PASSWORD '${workerPassword}'`);
  const metadata = JSON.stringify({ verifiedFiles: [{ path: "src/a.txt", blobSha: "a".repeat(40), mode: "100644", deleted: false }] }).replaceAll("'", "''");
  await adminPool.query(`
    INSERT INTO organizations(id,name) VALUES ('${org}','ZIP lifecycle');
    INSERT INTO users(id,supabase_user_id,email) VALUES ('${developer}','80000000-0000-4000-8000-000000000931','developer@example.com');
    INSERT INTO organization_memberships(organization_id,user_id,role) VALUES ('${org}','${developer}','developer');
    INSERT INTO projects(id,organization_id,name) VALUES ('${project}','${org}','ZIP lifecycle');
    INSERT INTO repositories(id,organization_id,project_id,provider,external_id,display_name) VALUES ('${repository}','${org}','${project}','upload','${project}','ZIP lifecycle');
    INSERT INTO project_versions(id,organization_id,project_id,version_number,storage_key,size_bytes,file_count,sha256,uploaded_by_user_id) VALUES ('${sourceVersion}','${org}','${project}',1,'source.zip',100,2,'${"b".repeat(64)}','${developer}');
    INSERT INTO tasks(id,organization_id,project_id,repository_id,requested_by_user_id,status,requirement,task_model_budget_usd) VALUES
      ('${task}','${org}','${project}','${repository}','${developer}','approved','change a',0.5),
      ('${raceTask}','${org}','${project}','${repository}','${developer}','approved','change race',0.5),
      ('${staleTask}','${org}','${project}','${repository}','${developer}','approved','change stale',0.5);
    INSERT INTO task_executions(id,organization_id,task_id,project_id,attempt,started_by_user_id,source_version_id,budget_usd,timeout_seconds,status,lease_owner,lease_expires_at,started_at,result_patch,change_document,result_metadata) VALUES
      ('${execution}','${org}','${task}','${project}',1,'${developer}','${sourceVersion}',1,600,'running','worker-a',now()+interval '1 minute',now(),'diff --git a/src/a.txt b/src/a.txt','note','${metadata}'::jsonb),
      ('${raceExecution}','${org}','${raceTask}','${project}',1,'${developer}','${sourceVersion}',1,600,'succeeded',NULL,NULL,now(),'diff --git a/src/a.txt b/src/a.txt','note','${metadata}'::jsonb),
      ('${staleExecution}','${org}','${staleTask}','${project}',1,'${developer}','${sourceVersion}',1,600,'succeeded',NULL,NULL,now(),'diff --git a/src/a.txt b/src/a.txt','note','${metadata}'::jsonb);
    UPDATE task_executions SET zip_build_status='failed',zip_build_error_code='ZIP_RESULT_FAILED',zip_build_error_message='failed once' WHERE id='${raceExecution}';
    UPDATE task_executions SET zip_build_status='building',zip_build_started_at=now()-interval '11 minutes' WHERE id='${staleExecution}';
  `);
  apiPool = new Pool({ connectionString: urlFor(databaseName, "coding_agent_api", apiPassword), max: 4 });
  workerPool = new Pool({ connectionString: urlFor(databaseName, "coding_agent_worker", workerPassword), max: 4 });
}, 30_000);

afterAll(async () => {
  await workerPool?.end(); await apiPool?.end(); await adminPool?.end();
  if (rootPool) {
    await waitForDatabaseBackendsToClose(rootPool, databaseName);
    await rootPool.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    await rootPool.end();
  }
}, 30_000);

describe.skipIf(!baseDatabaseUrl)("ZIP result build lifecycle", () => {
  it("finishes to pending transactionally, then a fresh worker recovers exactly one build and storage write", async () => {
    const executionQueue = new PostgresExecutionQueue(workerPool! as unknown as RestrictedQueryPool);
    await expect(executionQueue.finish(execution, "worker-a", "succeeded")).resolves.toBe("succeeded");
    const pending = await adminPool!.query<{ zip_build_status: string }>(`SELECT zip_build_status FROM task_executions WHERE id=$1`, [execution]);
    expect(pending.rows[0]!.zip_build_status).toBe("pending");

    const restricted = workerPool! as unknown as RestrictedQueryPool;
    const queue = new PostgresZipResultBuildQueue(restricted);
    const artifacts = new PostgresZipResultArtifactStore(restricted);
    const storageWrite = vi.fn(async () => undefined);
    const build = vi.fn(async () => {
      await storageWrite();
      await expect(artifacts.complete({ executionId: execution, artifactId: "70000000-0000-4000-8000-000000000931", storageKey: "result.zip", sha256: "c".repeat(64), sizeBytes: 200, fileCount: 3 })).resolves.toBe("inserted");
    });
    await runZipResultBuildWorkerOnce({ queue, build });
    await runZipResultBuildWorkerOnce({ queue, build });

    expect(build).toHaveBeenCalledTimes(1);
    expect(storageWrite).toHaveBeenCalledTimes(1);
    const ready = await adminPool!.query<{ zip_build_status: string }>(`SELECT zip_build_status FROM task_executions WHERE id=$1`, [execution]);
    expect(ready.rows[0]!.zip_build_status).toBe("ready");
    const artifactsCount = await adminPool!.query<{ count: string }>(`SELECT count(*)::text AS count FROM task_execution_artifacts WHERE execution_id=$1 AND kind='zip_result'`, [execution]);
    expect(artifactsCount.rows[0]!.count).toBe("1");
  });

  it("a retry POST racing the worker has only one builder claimant", async () => {
    const queue = new PostgresZipResultBuildQueue(workerPool! as unknown as RestrictedQueryPool);
    const database = createTaskZipResultDatabase(apiPool! as unknown as TenantPool);
    const session = { organizationId: org, userId: developer, expiresAtMs: Date.now() + 60_000 };
    const [workerClaim, retryClaim] = await Promise.all([queue.claimPending(), database.retryBuild(session, raceTask)]);
    expect(workerClaim).toBeNull();
    expect(retryClaim?.executionId).toBe(raceExecution);
    const state = await adminPool!.query<{ zip_build_status: string }>(`SELECT zip_build_status FROM task_executions WHERE id=$1`, [raceExecution]);
    expect(state.rows[0]!.zip_build_status).toBe("building");
    await database.markFailed(session, raceExecution, "ZIP_RESULT_FAILED", "cleanup");
  });

  it("marks an abandoned building state interrupted without auto-retrying it", async () => {
    const queue = new PostgresZipResultBuildQueue(workerPool! as unknown as RestrictedQueryPool);
    await expect(queue.claimPending()).resolves.toBeNull();
    const state = await adminPool!.query<{ zip_build_status: string; zip_build_error_code: string }>(`SELECT zip_build_status,zip_build_error_code FROM task_executions WHERE id=$1`, [staleExecution]);
    expect(state.rows[0]).toEqual({ zip_build_status: "failed", zip_build_error_code: "ZIP_RESULT_INTERRUPTED" });
    await expect(queue.claimPending()).resolves.toBeNull();
  });
});

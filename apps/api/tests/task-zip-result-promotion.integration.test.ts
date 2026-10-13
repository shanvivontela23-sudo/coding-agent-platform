import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";
import { testPool } from "./helpers/test-pool.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TenantPool } from "../src/database.js";
import { createTaskZipResultDatabase } from "../src/task-zip-result-database.js";
import type { TaskZipResultArtifact } from "../src/task-zip-result.js";

const baseDatabaseUrl = process.env.TEST_DATABASE_URL;
const databaseName = "coding_agent_zip_result_promotion";
const apiPassword = "coding-agent-zip-result-promotion-password";
const org = "00000000-0000-4000-8000-000000000821";
const developer = "10000000-0000-4000-8000-000000000821";
const project = "20000000-0000-4000-8000-000000000821";
const repository = "30000000-0000-4000-8000-000000000821";
const task = "40000000-0000-4000-8000-000000000821";
const execution = "50000000-0000-4000-8000-000000000821";
const sourceVersion = "60000000-0000-4000-8000-000000000821";
const resultVersion = "70000000-0000-4000-8000-000000000821";
const driftProject = "20000000-0000-4000-8000-000000000822";
const driftRepository = "30000000-0000-4000-8000-000000000822";
const driftTask = "40000000-0000-4000-8000-000000000822";
const driftExecution = "50000000-0000-4000-8000-000000000822";
const driftSource = "60000000-0000-4000-8000-000000000822";
const driftCurrent = "60000000-0000-4000-8000-000000000823";
const driftResult = "70000000-0000-4000-8000-000000000822";
let rootPool: Pool | null = null;
let adminPool: Pool | null = null;
let apiPool: Pool | null = null;

function urlFor(name: string, username?: string, password?: string): string {
  const url = new URL(baseDatabaseUrl!); url.pathname = `/${name}`; if (username) url.username = username; if (password) url.password = password; return url.toString();
}
function resultArtifact(overrides: Partial<TaskZipResultArtifact> = {}): TaskZipResultArtifact {
  return { executionId: execution, taskId: task, projectId: project, sourceVersionId: sourceVersion, artifactVersionId: resultVersion, storageKey: `${org}/${project}/${resultVersion}.zip`, sha256: "b".repeat(64), sizeBytes: 200, fileCount: 3, promotedVersionId: null, promotedVersionNumber: null, ...overrides };
}

beforeAll(async () => {
  if (!baseDatabaseUrl) return;
  rootPool = testPool({ connectionString: baseDatabaseUrl });
  await rootPool.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`); await rootPool.query(`CREATE DATABASE ${databaseName}`);
  adminPool = testPool({ connectionString: urlFor(databaseName) });
  for (const name of ["0001_tenant_core.sql","0002_organization_invitations.sql","0003_github_projects.sql","0004_task_intake.sql","0005_zip_projects_and_task_review_fixes.sql","0006_task_execution.sql","0007_task_execution_b2.sql","0008_verification_incomplete.sql","0009_github_publication.sql","0010_zip_results.sql"]) await adminPool.query(await readFile(join("packages/db/migrations", name), "utf8"));
  await adminPool.query(`ALTER ROLE coding_agent_api PASSWORD '${apiPassword}'`);
  const artifactMetadata = JSON.stringify({ sourceVersionId: sourceVersion, artifactVersionId: resultVersion, fileCount: 3 }).replaceAll("'", "''");
  const driftMetadata = JSON.stringify({ sourceVersionId: driftSource, artifactVersionId: driftResult, fileCount: 3 }).replaceAll("'", "''");
  await adminPool.query(`
    INSERT INTO organizations(id,name) VALUES ('${org}','ZIP Promotion');
    INSERT INTO users(id,supabase_user_id,email) VALUES ('${developer}','80000000-0000-4000-8000-000000000821','developer@example.com');
    INSERT INTO organization_memberships(organization_id,user_id,role) VALUES ('${org}','${developer}','developer');
    INSERT INTO projects(id,organization_id,name) VALUES ('${project}','${org}','ZIP A'),('${driftProject}','${org}','ZIP B');
    INSERT INTO repositories(id,organization_id,project_id,provider,external_id,display_name) VALUES
      ('${repository}','${org}','${project}','upload','${project}','ZIP A'),
      ('${driftRepository}','${org}','${driftProject}','upload','${driftProject}','ZIP B');
    INSERT INTO project_versions(id,organization_id,project_id,version_number,storage_key,size_bytes,file_count,sha256,uploaded_by_user_id) VALUES
      ('${sourceVersion}','${org}','${project}',1,'source-a.zip',100,2,'${"a".repeat(64)}','${developer}'),
      ('${driftSource}','${org}','${driftProject}',1,'source-b1.zip',100,2,'${"c".repeat(64)}','${developer}'),
      ('${driftCurrent}','${org}','${driftProject}',2,'source-b2.zip',110,2,'${"d".repeat(64)}','${developer}');
    INSERT INTO tasks(id,organization_id,project_id,repository_id,requested_by_user_id,status,requirement,task_model_budget_usd) VALUES
      ('${task}','${org}','${project}','${repository}','${developer}','draft','change a',0.5),
      ('${driftTask}','${org}','${driftProject}','${driftRepository}','${developer}','draft','change b',0.5);
    UPDATE tasks SET status='plan_ready',what_i_understand='change',proposed_approach='change file',planned_source_version_id='${sourceVersion}' WHERE id='${task}';
    UPDATE tasks SET status='plan_ready',what_i_understand='change',proposed_approach='change file',planned_source_version_id='${driftSource}' WHERE id='${driftTask}';
    UPDATE tasks SET status='approved',confirmed_requirement='change',confirmed_plan='change file',approved_at=now() WHERE id IN ('${task}','${driftTask}');
    INSERT INTO task_executions(id,organization_id,task_id,project_id,attempt,started_by_user_id,source_version_id,budget_usd,timeout_seconds,status,finished_at,result_patch,change_document,result_metadata) VALUES
      ('${execution}','${org}','${task}','${project}',1,'${developer}','${sourceVersion}',1,600,'succeeded',now(),'diff --git a/a b/a','note','{}'::jsonb),
      ('${driftExecution}','${org}','${driftTask}','${driftProject}',1,'${developer}','${driftSource}',1,600,'succeeded',now(),'diff --git a/b b/b','note','{}'::jsonb);
    INSERT INTO task_execution_artifacts(id,organization_id,task_id,execution_id,kind,storage_key,sha256,size_bytes,metadata) VALUES
      ('${resultVersion}','${org}','${task}','${execution}','zip_result','${org}/${project}/${resultVersion}.zip','${"b".repeat(64)}',200,'${artifactMetadata}'::jsonb),
      ('${driftResult}','${org}','${driftTask}','${driftExecution}','zip_result','${org}/${driftProject}/${driftResult}.zip','${"e".repeat(64)}',200,'${driftMetadata}'::jsonb);
  `);
  apiPool = testPool({ connectionString: urlFor(databaseName, "coding_agent_api", apiPassword), max: 4 });
}, 30_000);

afterAll(async () => { await apiPool?.end(); await adminPool?.end(); if (rootPool) { await rootPool.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`); await rootPool.end(); } }, 30_000);

describe.skipIf(!baseDatabaseUrl)("B4 ZIP promotion database boundary", () => {
  it("promotes once, keeps the source version, and audits promotion exactly once", async () => {
    const database = createTaskZipResultDatabase(apiPool! as unknown as TenantPool);
    const session = { organizationId: org, userId: developer, expiresAtMs: Date.now() + 60_000 };
    const first = await database.promote(session, resultArtifact());
    expect(first).toMatchObject({ promotedVersionId: resultVersion, promotedVersionNumber: 2 });
    const second = await database.promote(session, resultArtifact());
    expect(second).toMatchObject({ promotedVersionId: resultVersion, promotedVersionNumber: 2 });
    const versions = await adminPool!.query<{ id: string; version_number: number }>(`SELECT id,version_number FROM project_versions WHERE organization_id=$1 AND project_id=$2 ORDER BY version_number`, [org, project]);
    expect(versions.rows).toEqual([{ id: sourceVersion, version_number: 1 }, { id: resultVersion, version_number: 2 }]);
    const audits = await adminPool!.query<{ count: string }>(`SELECT count(*)::text AS count FROM audit_events WHERE organization_id=$1 AND task_id=$2 AND event_type='project_version_promoted'`, [org, task]);
    expect(audits.rows[0]!.count).toBe("1");
  });

  it("refuses promotion when current source moved beyond the approved version", async () => {
    const database = createTaskZipResultDatabase(apiPool! as unknown as TenantPool);
    const session = { organizationId: org, userId: developer, expiresAtMs: Date.now() + 60_000 };
    await expect(database.promote(session, resultArtifact({ executionId: driftExecution, taskId: driftTask, projectId: driftProject, sourceVersionId: driftSource, artifactVersionId: driftResult, storageKey: `${org}/${driftProject}/${driftResult}.zip`, sha256: "e".repeat(64) }))).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    const count = await adminPool!.query<{ count: string }>(`SELECT count(*)::text AS count FROM project_versions WHERE organization_id=$1 AND project_id=$2 AND id=$3`, [org, driftProject, driftResult]);
    expect(count.rows[0]!.count).toBe("0");
  });
});

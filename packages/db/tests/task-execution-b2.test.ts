import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const baseDatabaseUrl = process.env.TEST_DATABASE_URL;
const integrationDb = "coding_agent_task_execution_b2";
const migrations = [
  "packages/db/migrations/0001_tenant_core.sql",
  "packages/db/migrations/0002_organization_invitations.sql",
  "packages/db/migrations/0003_github_projects.sql",
  "packages/db/migrations/0004_task_intake.sql",
  "packages/db/migrations/0005_zip_projects_and_task_review_fixes.sql",
  "packages/db/migrations/0006_task_execution.sql",
  "packages/db/migrations/0007_task_execution_b2.sql",
] as const;

const org = "00000000-0000-4000-8000-000000000211";
const rep = "10000000-0000-4000-8000-000000000211";
const project = "20000000-0000-4000-8000-000000000211";
const task = "40000000-0000-4000-8000-000000000211";
const commit = "c".repeat(40);

function databaseUrlFor(name: string): string {
  const url = new URL(baseDatabaseUrl!);
  url.pathname = `/${name}`;
  return url.toString();
}

async function psql(databaseUrl: string, sql: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "psql",
    [databaseUrl, "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-c", sql],
    { encoding: "utf8" },
  );
  return stdout.trim();
}

async function expectPsqlFailure(databaseUrl: string, sql: string): Promise<void> {
  await expect(psql(databaseUrl, sql)).rejects.toThrow();
}

beforeAll(async () => {
  if (!baseDatabaseUrl) return;
  await psql(baseDatabaseUrl, `DROP DATABASE IF EXISTS ${integrationDb} WITH (FORCE)`);
  await psql(baseDatabaseUrl, `CREATE DATABASE ${integrationDb}`);
  const databaseUrl = databaseUrlFor(integrationDb);
  for (const migration of migrations) {
    await execFileAsync(
      "psql",
      [databaseUrl, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", migration],
      { encoding: "utf8" },
    );
  }
  await psql(databaseUrl, `
    INSERT INTO organizations (id,name) VALUES ('${org}','Execution B2');
    INSERT INTO users (id,supabase_user_id,email)
      VALUES ('${rep}','60000000-0000-4000-8000-000000000211','rep-b2@example.com');
    INSERT INTO organization_memberships (organization_id,user_id,role)
      VALUES ('${org}','${rep}','rep');
    INSERT INTO projects (id,organization_id,name)
      VALUES ('${project}','${org}','Demo');
    INSERT INTO project_reports (organization_id,project_id,report,analysed_commit)
      VALUES ('${org}','${project}','{}'::jsonb,'${commit}');
    INSERT INTO tasks (id,organization_id,project_id,requested_by_user_id,status,requirement,task_model_budget_usd)
      VALUES ('${task}','${org}','${project}','${rep}','draft','Fix retry',0.50);
    UPDATE tasks SET status='plan_ready',what_i_understand='Fix retry',proposed_approach='Change retry behavior'
      WHERE id='${task}';
    UPDATE tasks SET status='approved',confirmed_requirement='Fix retry',confirmed_plan='Change retry behavior',approved_at=now()
      WHERE id='${task}';
  `);
}, 30_000);

afterAll(async () => {
  if (baseDatabaseUrl) await psql(baseDatabaseUrl, `DROP DATABASE IF EXISTS ${integrationDb} WITH (FORCE)`);
}, 30_000);

describe.skipIf(!baseDatabaseUrl)("B2 execution worker database boundary", () => {
  it("gives the worker queue functions but no direct tenant table access", async () => {
    const databaseUrl = databaseUrlFor(integrationDb);
    expect(await psql(databaseUrl, `
      SELECT rolsuper||'|'||rolbypassrls||'|'||rolinherit
      FROM pg_roles WHERE rolname='coding_agent_worker';
    `)).toBe("false|false|false");

    await expectPsqlFailure(databaseUrl, `SET ROLE coding_agent_worker; SELECT count(*) FROM task_executions;`);
    await expectPsqlFailure(databaseUrl, `SET ROLE coding_agent_api; SELECT count(*) FROM public.claim_task_execution('api-worker',30);`);

    expect(await psql(databaseUrl, `
      SET ROLE coding_agent_worker;
      BEGIN;
      SET LOCAL ROLE coding_agent_app;
      SELECT pg_catalog.set_config('app.organization_id','${org}',true);
      SELECT count(*) FROM tasks WHERE id='${task}';
      COMMIT;
    `)).toContain("1");

    await expectPsqlFailure(databaseUrl, `
      SET ROLE coding_agent_app;
      SELECT pg_catalog.set_config('app.organization_id','${org}',false);
      DELETE FROM task_executions WHERE task_id='${task}';
    `);
  });

  it("fails an interrupted paid coding step instead of reclaiming it", async () => {
    const databaseUrl = databaseUrlFor(integrationDb);
    const execution = "50000000-0000-4000-8000-000000000211";
    await psql(databaseUrl, `
      INSERT INTO task_executions
        (id,organization_id,task_id,project_id,attempt,started_by_user_id,source_commit_sha,budget_usd,timeout_seconds)
      VALUES
        ('${execution}','${org}','${task}','${project}',1,'${rep}','${commit}',1.00,120);
    `);
    expect(await psql(databaseUrl, `SET ROLE coding_agent_worker; SELECT execution_id FROM public.claim_task_execution('worker-a',30);`)).toBe(execution);
    await psql(databaseUrl, `
      UPDATE task_executions
         SET coding_started_at=now(),lease_expires_at=now()-interval '1 second'
       WHERE id='${execution}';
    `);
    expect(await psql(databaseUrl, `SET ROLE coding_agent_worker; SELECT count(*) FROM public.claim_task_execution('worker-b',30);`)).toBe("0");
    expect(await psql(databaseUrl, `SELECT status||'|'||failure_code FROM task_executions WHERE id='${execution}';`))
      .toBe("failed|WORKER_INTERRUPTED");
    expect(await psql(databaseUrl, `
      SELECT event_type||'|'||payload->>'failure_code'
        FROM audit_events
       WHERE payload->>'execution_id'='${execution}'
       ORDER BY created_at DESC LIMIT 1;
    `)).toBe("task_execution_failed|WORKER_INTERRUPTED");
  });

  it("audits worker success, failure, cancellation, and timeout terminal transitions", async () => {
    const databaseUrl = databaseUrlFor(integrationDb);
    const rows = [
      ["50000000-0000-4000-8000-000000000212", 2],
      ["50000000-0000-4000-8000-000000000213", 3],
      ["50000000-0000-4000-8000-000000000214", 4],
      ["50000000-0000-4000-8000-000000000215", 5],
    ] as const;
    for (const [id, attempt] of rows) {
      await psql(databaseUrl, `
        INSERT INTO task_executions
          (id,organization_id,task_id,project_id,attempt,started_by_user_id,source_commit_sha,budget_usd,timeout_seconds)
        VALUES
          ('${id}','${org}','${task}','${project}',${attempt},'${rep}','${commit}',1.00,120);
      `);
      expect(await psql(databaseUrl, `SET ROLE coding_agent_worker; SELECT execution_id FROM public.claim_task_execution('worker-${attempt}',30);`)).toBe(id);
      if (attempt === 2) {
        expect(await psql(databaseUrl, `SET ROLE coding_agent_worker; SELECT public.finish_task_execution('${id}','worker-${attempt}','succeeded',NULL,NULL);`)).toBe("succeeded");
      } else if (attempt === 3) {
        expect(await psql(databaseUrl, `SET ROLE coding_agent_worker; SELECT public.finish_task_execution('${id}','worker-${attempt}','failed','RUNNER_FAILED','Implementation failed.');`)).toBe("failed");
      } else if (attempt === 4) {
        await psql(databaseUrl, `UPDATE task_executions SET cancel_requested_at=now() WHERE id='${id}';`);
        expect(await psql(databaseUrl, `SET ROLE coding_agent_worker; SELECT public.heartbeat_task_execution('${id}','worker-${attempt}',30);`)).toBe("cancelled");
      } else {
        await psql(databaseUrl, `UPDATE task_executions SET started_at=now()-interval '5 minutes' WHERE id='${id}';`);
        expect(await psql(databaseUrl, `SET ROLE coding_agent_worker; SELECT public.heartbeat_task_execution('${id}','worker-${attempt}',30);`)).toBe("timed_out");
      }
    }

    expect(await psql(databaseUrl, `
      SELECT string_agg(event_type||':'||COALESCE(payload->>'failure_code',''),',' ORDER BY event_type)
        FROM audit_events
       WHERE payload->>'execution_id' IN ('${rows[0][0]}','${rows[1][0]}','${rows[2][0]}','${rows[3][0]}');
    `)).toBe(
      "task_execution_cancelled:,task_execution_failed:RUNNER_FAILED,task_execution_succeeded:,task_execution_timed_out:EXECUTION_TIMEOUT",
    );
  });
});

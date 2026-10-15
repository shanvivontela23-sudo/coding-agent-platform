import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type TenantPool, withTenant } from "../src/database.js";
import { recordProjectDecision } from "../src/project-decision-database.js";
import { syncPullRequestOutcomesOnce, type PullRequestStateReader } from "../../worker/src/pull-request-outcome-sync.js";
import { testPool } from "./helpers/test-pool.js";

const baseDatabaseUrl = process.env.TEST_DATABASE_URL;
const integrationDb = "coding_agent_pull_request_outcomes";
const apiPassword = "coding-agent-pr-outcome-api-password";
const workerPassword = "coding-agent-pr-outcome-worker-password";
const commit = "a".repeat(40);
let rootPool: Pool | null = null;
let adminPool: Pool | null = null;
let apiPool: Pool | null = null;
let workerPool: Pool | null = null;

type Tenant = { org: string; user: string; project: string; repo: string; task: string; execution: string; publication: string; installation: number; githubRepo: number; fullName: string };
const tenantFor = (n: number, installation: number, githubRepo: number, fullName: string): Tenant => ({
  org: `00000000-0000-4000-8000-00000000095${n}`, user: `10000000-0000-4000-8000-00000000095${n}`, project: `20000000-0000-4000-8000-00000000095${n}`,
  repo: `30000000-0000-4000-8000-00000000095${n}`, task: `40000000-0000-4000-8000-00000000095${n}`, execution: `50000000-0000-4000-8000-00000000095${n}`,
  publication: `80000000-0000-4000-8000-00000000095${n}`, installation, githubRepo, fullName,
});
const a = tenantFor(1, 111, 222, "acme/demo");
const b = tenantFor(2, 333, 444, "other/demo");

function databaseUrlFor(name: string, user?: string, password?: string): string {
  const url = new URL(baseDatabaseUrl!);
  url.pathname = `/${name}`;
  if (user) url.username = user;
  if (password) url.password = password;
  return url.toString();
}

function seed(t: Tenant): string {
  return `
    INSERT INTO organizations (id,name) VALUES ('${t.org}','Org ${t.fullName}');
    INSERT INTO users (id,supabase_user_id,email) VALUES ('${t.user}','6${t.user.slice(1)}','dev-${t.installation}@example.com');
    INSERT INTO organization_memberships (organization_id,user_id,role) VALUES ('${t.org}','${t.user}','owner');
    INSERT INTO github_installations (organization_id,installation_id,connected_by_user_id,status) VALUES ('${t.org}',${t.installation},'${t.user}','connected');
    INSERT INTO projects (id,organization_id,name) VALUES ('${t.project}','${t.org}','Demo');
    INSERT INTO repositories (id,organization_id,project_id,provider,external_id,display_name,github_repository_id,full_name,default_branch)
      VALUES ('${t.repo}','${t.org}','${t.project}','github','${t.githubRepo}','${t.fullName}',${t.githubRepo},'${t.fullName}','main');
    INSERT INTO project_reports (organization_id,project_id,report,analysed_commit) VALUES ('${t.org}','${t.project}','{"installCommand":"npm ci"}'::jsonb,'${commit}');
    INSERT INTO tasks (id,organization_id,project_id,repository_id,requested_by_user_id,status,requirement,task_model_budget_usd) VALUES ('${t.task}','${t.org}','${t.project}','${t.repo}','${t.user}','draft','Fix refunds',0.50);
    UPDATE tasks SET status='plan_ready',what_i_understand='Fix refunds',proposed_approach='Update src/refund.js' WHERE id='${t.task}';
    UPDATE tasks SET status='approved',confirmed_requirement='Fix refunds',confirmed_plan='Update src/refund.js',approved_at=now() WHERE id='${t.task}';
    INSERT INTO task_executions (id,organization_id,task_id,project_id,attempt,started_by_user_id,source_commit_sha,budget_usd,timeout_seconds,status,finished_at,result_patch,change_document)
      VALUES ('${t.execution}','${t.org}','${t.task}','${t.project}',1,'${t.user}','${commit}',1.00,600,'succeeded',now(),'diff --git a/src/refund.js b/src/refund.js','## What was asked');
    INSERT INTO task_execution_publications (id,organization_id,task_id,execution_id,requested_by_user_id,status,branch_name,approved_sha)
      VALUES ('${t.publication}','${t.org}','${t.task}','${t.execution}','${t.user}','publishing','dhara/execution-${t.execution}','${commit}');
    UPDATE task_execution_publications SET status='published',base_moved_commits=0,pull_request_number=7,pull_request_url='https://github.com/${t.fullName}/pull/7' WHERE id='${t.publication}';
  `;
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
  await adminPool.query(`ALTER ROLE coding_agent_worker PASSWORD '${workerPassword}'`);
  await adminPool.query(seed(a) + seed(b));
  apiPool = testPool({ connectionString: databaseUrlFor(integrationDb, "coding_agent_api", apiPassword), max: 4 });
  workerPool = testPool({ connectionString: databaseUrlFor(integrationDb, "coding_agent_worker", workerPassword), max: 4 });
  // What publication already wrote: the "Published pull request #7" memory entry.
  for (const t of [a, b]) {
    await withTenant(apiPool as unknown as TenantPool, { organizationId: t.org }, async (database) => await recordProjectDecision(database, t.org, {
      projectId: t.project, taskId: t.task, kind: "reviewer_accepted", summary: "Published pull request #7.",
      detail: { executionId: t.execution, pullRequestNumber: 7 }, source: "publication", memoryKey: `publication:${t.execution}`,
    }));
  }
}, 60_000);

afterAll(async () => {
  await workerPool?.end();
  await apiPool?.end();
  await adminPool?.end();
  if (rootPool) await rootPool.query(`DROP DATABASE IF EXISTS ${integrationDb} WITH (FORCE)`);
  await rootPool?.end();
}, 30_000);

describe.skipIf(!baseDatabaseUrl)("pull request outcomes in Postgres", () => {
  it("gives each role only its own lookup", async () => {
    const listed = await workerPool!.query<{ organization_id: string; repository_full_name: string; installation_id: string }>("SELECT * FROM public.list_unresolved_pull_requests(10,0)");
    expect(listed.rows.map((row) => [row.organization_id, row.repository_full_name, Number(row.installation_id)]).sort()).toEqual([[a.org, a.fullName, 111], [b.org, b.fullName, 333]]);
    await expect(apiPool!.query("SELECT * FROM public.list_unresolved_pull_requests(10,0)")).rejects.toThrow(/permission denied/);
    await expect(workerPool!.query("SELECT * FROM public.find_publication_for_pull_request(111,222,7)")).rejects.toThrow(/permission denied/);
    await expect(workerPool!.query("SELECT * FROM public.list_unresolved_pull_requests(1000,0)")).rejects.toThrow(/limit/);

    const found = await apiPool!.query("SELECT * FROM public.find_publication_for_pull_request(111,222,7)");
    expect(found.rows).toEqual([{ organization_id: a.org, publication_id: a.publication }]);
    // The repository id must belong to the installation's organization.
    expect((await apiPool!.query("SELECT * FROM public.find_publication_for_pull_request(111,444,7)")).rows).toEqual([]);
    expect((await apiPool!.query("SELECT * FROM public.find_publication_for_pull_request(111,222,8)")).rows).toEqual([]);
  });

  it("records a merge once, replaces the published memory entry, and keeps open pull requests on a back-off", async () => {
    const reader: PullRequestStateReader = { async read(input) { return input.installationId === 111 ? "merged" : "open"; } };
    const first = await syncPullRequestOutcomesOnce({ pool: workerPool!, reader, minAgeSeconds: 300 });
    expect(first).toEqual({ checked: 2, recorded: 1, failed: 0 });

    const rows = await adminPool!.query<{ id: string; pull_request_state: string; resolved: boolean; checked: boolean }>("SELECT id,pull_request_state,pull_request_resolved_at IS NOT NULL AS resolved,pull_request_checked_at IS NOT NULL AS checked FROM task_execution_publications ORDER BY id");
    expect(rows.rows).toEqual([{ id: a.publication, pull_request_state: "merged", resolved: true, checked: true }, { id: b.publication, pull_request_state: "open", resolved: false, checked: true }]);

    const memory = await adminPool!.query<{ organization_id: string; summary: string; current: boolean }>("SELECT organization_id,summary,superseded_by IS NULL AS current FROM project_decisions ORDER BY organization_id,created_at,summary");
    expect(memory.rows).toEqual([
      { organization_id: a.org, summary: "Published pull request #7.", current: false },
      { organization_id: a.org, summary: "Pull request #7 was merged.", current: true },
      { organization_id: b.org, summary: "Published pull request #7.", current: true },
    ]);

    // Merged is gone from the queue; the open one waits for the back-off.
    expect(await syncPullRequestOutcomesOnce({ pool: workerPool!, reader, minAgeSeconds: 300 })).toEqual({ checked: 0, recorded: 0, failed: 0 });
    expect((await syncPullRequestOutcomesOnce({ pool: workerPool!, reader, minAgeSeconds: 0 })).checked).toBe(1);
  });

  it("treats merged or closed as final and keeps state and resolution time consistent", async () => {
    await expect(adminPool!.query(`UPDATE task_execution_publications SET pull_request_state='open',pull_request_resolved_at=NULL WHERE id='${a.publication}'`)).rejects.toThrow(/final/);
    await expect(adminPool!.query(`UPDATE task_execution_publications SET pull_request_state='closed' WHERE id='${b.publication}'`)).rejects.toThrow(/resolved_state/);
    await expect(adminPool!.query(`UPDATE task_execution_publications SET pull_request_state='bogus' WHERE id='${b.publication}'`)).rejects.toThrow(/check/i);
  });
});

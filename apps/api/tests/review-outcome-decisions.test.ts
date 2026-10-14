import { describe, expect, it } from "vitest";
import type { TenantPool } from "../src/database.js";
import { createTaskPublicationDatabase } from "../src/task-publication-database.js";
import { createTaskZipResultDatabase } from "../src/task-zip-result-database.js";

const session = { organizationId: "00000000-0000-4000-8000-000000000911", userId: "10000000-0000-4000-8000-000000000911", expiresAtMs: Date.now() + 60_000 };
const taskId = "40000000-0000-4000-8000-000000000911";
const projectId = "20000000-0000-4000-8000-000000000911";
const executionId = "50000000-0000-4000-8000-000000000911";

function fakePool(query: <Row>(text: string, values?: readonly unknown[]) => Promise<{ rows: Row[] }>): TenantPool {
  const client = { query, release() {} };
  return { connect: async () => client, query } as TenantPool;
}

describe("deterministic review outcome memories", () => {
  it("records GitHub publication once in the publication transaction", async () => {
    const decisions: Array<Record<string, unknown>> = [];
    let publicationStatus = "publishing";
    const query = async <Row>(text: string, values?: readonly unknown[]): Promise<{ rows: Row[] }> => {
      if (text.includes("UPDATE task_execution_publications p SET status='published'")) {
        if (publicationStatus !== "publishing") return { rows: [] };
        publicationStatus = "published"; return { rows: [{ project_id: projectId, execution_id: executionId }] as Row[] };
      }
      if (text.includes("FROM project_decisions") && text.includes("FOR UPDATE")) return { rows: [] };
      if (text.includes("INSERT INTO project_decisions")) { decisions.push(JSON.parse(String(values?.[5])) as Record<string, unknown>); return { rows: [{ id: "70000000-0000-4000-8000-000000000911", organization_id: session.organizationId, project_id: projectId, task_id: taskId, kind: values?.[3], summary: values?.[4], detail: JSON.parse(String(values?.[5])), source: values?.[6], created_at: "2026-10-14T00:00:00.000Z", superseded_by: null }] as Row[] }; }
      if (text.includes("FROM task_execution_publications p")) return { rows: [{ execution_id: executionId, status: publicationStatus, branch_name: "dhara/demo", base_moved_commits: 0, pull_request_number: 17, pull_request_url: "https://github.com/acme/demo/pull/17", unproven: false, failure_code: null, failure_message: null }] as Row[] };
      return { rows: [] };
    };
    const database = createTaskPublicationDatabase(fakePool(query));
    const result = { status: "published" as const, branchName: "dhara/demo", baseMovedCommits: 0, currentHeadSha: "a".repeat(40), branchHeadSha: "b".repeat(40), pullRequestNumber: 17, pullRequestUrl: "https://github.com/acme/demo/pull/17" };
    await database.markPublished(session, taskId, result);
    await database.markPublished(session, taskId, result);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ memoryKey: `publication:${executionId}`, executionId, pullRequestNumber: 17 });
  });

  it("records ZIP promotion once and does not fabricate another memory on retry", async () => {
    const decisions: Array<Record<string, unknown>> = [];
    let promoted = false;
    const artifactMetadata = () => ({ sourceVersionId: "60000000-0000-4000-8000-000000000911", artifactVersionId: "70000000-0000-4000-8000-000000000911", fileCount: 1, ...(promoted ? { promotedVersionId: "70000000-0000-4000-8000-000000000911", promotedVersionNumber: 2 } : {}) });
    const artifactRow = () => ({ execution_id: executionId, task_id: taskId, project_id: projectId, storage_key: "result.zip", sha256: "a".repeat(64), size_bytes: 20, metadata: artifactMetadata() });
    const query = async <Row>(text: string, values?: readonly unknown[]): Promise<{ rows: Row[] }> => {
      if (text.includes("FROM organization_memberships")) return { rows: [{ role: "developer" }] as Row[] };
      if (text.includes("task_execution_artifacts a") && text.includes("FOR UPDATE")) return { rows: [artifactRow()] as Row[] };
      if (text.includes("FROM project_versions")) return { rows: [{ id: "60000000-0000-4000-8000-000000000911", version_number: 1 }] as Row[] };
      if (text.includes("UPDATE task_execution_artifacts a SET metadata")) { promoted = true; return { rows: [artifactRow()] as Row[] }; }
      if (text.includes("FROM project_decisions") && text.includes("FOR UPDATE")) return { rows: [] };
      if (text.includes("INSERT INTO project_decisions")) { decisions.push(JSON.parse(String(values?.[5])) as Record<string, unknown>); return { rows: [{ id: "70000000-0000-4000-8000-000000000912", organization_id: session.organizationId, project_id: projectId, task_id: taskId, kind: values?.[3], summary: values?.[4], detail: JSON.parse(String(values?.[5])), source: values?.[6], created_at: "2026-10-14T00:00:00.000Z", superseded_by: null }] as Row[] }; }
      return { rows: [] };
    };
    const database = createTaskZipResultDatabase(fakePool(query));
    const input = { executionId, taskId, projectId, sourceVersionId: "60000000-0000-4000-8000-000000000911", artifactVersionId: "70000000-0000-4000-8000-000000000911", storageKey: "result.zip", sha256: "a".repeat(64), sizeBytes: 20, fileCount: 1, promotedVersionId: null, promotedVersionNumber: null };
    await database.promote(session, input);
    await database.promote(session, input);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ memoryKey: `zip-promotion:${executionId}`, executionId, versionNumber: 2 });
  });
});

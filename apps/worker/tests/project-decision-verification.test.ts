import { describe, expect, it } from "vitest";
import type { TenantPool } from "../../api/src/database.js";
import { PostgresExecutionStore } from "../src/execution-store.js";
import type { ClaimedExecution } from "../src/postgres-execution-queue.js";
import type { VerificationResult } from "../src/verification.js";

const execution: ClaimedExecution = {
  executionId: "50000000-0000-4000-8000-000000000631", organizationId: "00000000-0000-4000-8000-000000000631",
  taskId: "40000000-0000-4000-8000-000000000631", projectId: "20000000-0000-4000-8000-000000000631", attempt: 1,
  sourceCommitSha: "a".repeat(40), sourceVersionId: null, budgetUsd: 1, timeoutSeconds: 600,
};

type Stored = { id: string; organization_id: string; project_id: string; task_id: string | null; kind: "command_worked" | "command_failed"; summary: string; detail: Record<string, unknown>; source: "verification"; created_at: string; superseded_by: string | null; same_detail?: boolean };

function pool() {
  const rows: Stored[] = [];
  const calls: Array<{ text: string; values?: readonly unknown[] }> = [];
  const query = async <Row>(text: string, values?: readonly unknown[]): Promise<{ rows: Row[] }> => {
    calls.push({ text, ...(values ? { values } : {}) });
    if (text.includes("FROM project_decisions") && text.includes("FOR UPDATE")) {
      const current = rows.find((row) => row.superseded_by === null && row.source === values?.[2] && row.detail.memoryKey === values?.[3]);
      if (!current) return { rows: [] };
      return { rows: [{ ...current, same_detail: JSON.stringify(current.detail) === JSON.stringify(JSON.parse(String(values?.[4]))) }] as Row[] };
    }
    if (text.includes("INSERT INTO project_decisions")) {
      const created: Stored = { id: `70000000-0000-4000-8000-${String(rows.length + 1).padStart(12, "0")}`, organization_id: String(values?.[0]), project_id: String(values?.[1]), task_id: values?.[2] === null ? null : String(values?.[2]), kind: values?.[3] as Stored["kind"], summary: String(values?.[4]), detail: JSON.parse(String(values?.[5])) as Record<string, unknown>, source: "verification", created_at: "2026-10-14T00:00:00.000Z", superseded_by: null };
      rows.push(created); return { rows: [created] as Row[] };
    }
    if (text.includes("UPDATE project_decisions SET superseded_by=id")) {
      const current = rows.find((row) => row.id === values?.[1]); if (current) current.superseded_by = current.id;
    }
    if (text.includes("UPDATE project_decisions SET superseded_by=$3")) {
      const previous = rows.find((row) => row.id === values?.[1]); if (previous) previous.superseded_by = String(values?.[2]);
    }
    return { rows: [] };
  };
  const client = { query, release() {} };
  return { rows, calls, value: { query, connect: async () => client } as unknown as TenantPool };
}

function verification(status: "passed" | "failed" | "pre_existing"): VerificationResult {
  return {
    checks: [{ name: "test", command: "pnpm test -- --reporter=user@example.com", baselineExitCode: status === "passed" ? 0 : 1, patchedExitCode: status === "passed" ? 0 : 1, status, baselineFailingTests: [], patchedFailingTests: [] }],
    hasNewFailures: status === "failed", complete: true, incompleteReason: null,
    reproduce: { command: null, baselineExitCode: null, patchedExitCode: null, baselineOutput: "", patchedOutput: "", baselineClassification: "not_run", patchedClassification: "not_run", reproduced: false, reason: null },
  };
}

describe("verification-driven project decisions", () => {
  it("masks and records facts idempotently, then supersedes a changed outcome", async () => {
    const database = pool(); const store = new PostgresExecutionStore(database.value);
    await store.saveVerification(execution, { verification: verification("passed"), changeDocument: "note", costUsd: 0.1 });
    await store.saveVerification(execution, { verification: verification("passed"), changeDocument: "note", costUsd: 0.1 });
    expect(database.rows).toHaveLength(1);
    expect(database.rows[0]).toMatchObject({ kind: "command_worked", superseded_by: null });
    expect(JSON.stringify(database.rows[0])).not.toContain("user@example.com");

    await store.saveVerification(execution, { verification: verification("failed"), changeDocument: "note", costUsd: 0.1 });
    expect(database.rows).toHaveLength(2);
    expect(database.rows[0]?.superseded_by).toBe(database.rows[1]?.id);
    expect(database.rows[1]).toMatchObject({ kind: "command_failed", superseded_by: null });
  });

  it("does not turn a pre-existing repository failure into learned project guidance", async () => {
    const database = pool(); const store = new PostgresExecutionStore(database.value);
    await store.saveVerification(execution, { verification: verification("pre_existing"), changeDocument: "note", costUsd: 0.1 });
    expect(database.rows).toHaveLength(0);
  });
});


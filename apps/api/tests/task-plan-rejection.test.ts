import { describe, expect, it, vi } from "vitest";
import { createTaskDatabase, type TaskDatabase } from "../src/task-database.js";
import type { TenantPool } from "../src/database.js";
import { createTaskReadService } from "../src/task-service.js";
import { createTicketCipher } from "../src/ticket-crypto.js";

const session = { organizationId: "00000000-0000-4000-8000-000000000901", userId: "10000000-0000-4000-8000-000000000901", expiresAtMs: Date.now() + 60_000 };
const taskId = "40000000-0000-4000-8000-000000000901";

describe("task plan rejection", () => {
  it("masks the requester's reason before persistence", async () => {
    const rejectTask = vi.fn(async () => undefined);
    const service = createTaskReadService({ database: { rejectTask } as unknown as TaskDatabase, cipher: createTicketCipher("task-plan-rejection-test-secret-long-enough") });
    await service.reject(session, taskId, "Alice at alice@example.com says this changes billing");
    expect(rejectTask).toHaveBeenCalledWith(session, taskId, "Alice at [MASKED_EMAIL] says this changes billing");
    expect(JSON.stringify(rejectTask.mock.calls)).not.toContain("alice@example.com");
  });

  it("rejects empty or oversized reasons before touching the database", async () => {
    const rejectTask = vi.fn(async () => undefined);
    const service = createTaskReadService({ database: { rejectTask } as unknown as TaskDatabase, cipher: createTicketCipher("task-plan-rejection-test-secret-long-enough") });
    await expect(service.reject(session, taskId, "   ")).rejects.toThrow("rejection reason");
    await expect(service.reject(session, taskId, "x".repeat(1001))).rejects.toThrow("rejection reason");
    expect(rejectTask).not.toHaveBeenCalled();
  });

  it("enforces requester-only plan-ready transition and records the masked fact atomically", async () => {
    const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
    let allow = true;
    const client = {
      async query<Row>(text: string, values?: readonly unknown[]) {
        queries.push({ text, ...(values ? { values } : {}) });
        if (text.includes("UPDATE tasks SET status='rejected'")) return { rows: allow ? [{ project_id: "20000000-0000-4000-8000-000000000901" }] as Row[] : [] as Row[] };
        if (text.includes("FROM project_decisions") && text.includes("FOR UPDATE")) return { rows: [] as Row[] };
        if (text.includes("INSERT INTO project_decisions")) return { rows: [{ id: "70000000-0000-4000-8000-000000000901", organization_id: session.organizationId, project_id: "20000000-0000-4000-8000-000000000901", task_id: taskId, kind: "reviewer_rejected", summary: "The requester rejected a proposed plan.", detail: JSON.parse(String(values?.[5])), source: "plan_review", created_at: "2026-10-14T00:00:00.000Z", superseded_by: null }] as Row[] };
        return { rows: [] as Row[] };
      },
      release() {},
    };
    const database = createTaskDatabase({ connect: async () => client, query: client.query } as unknown as TenantPool);
    await database.rejectTask(session, taskId, "Email [MASKED_EMAIL]");
    const insert = queries.find(({ text }) => text.includes("INSERT INTO project_decisions"));
    expect(insert?.values?.[4]).toBe("The requester rejected a proposed plan: Email [MASKED_EMAIL]");
    expect(queries.some(({ text }) => text.includes("'task_plan_rejected'"))).toBe(true);

    allow = false; queries.length = 0;
    await expect(database.rejectTask(session, taskId, "No")).rejects.toMatchObject({ code: "TASK_REJECTION_NOT_ALLOWED" });
    expect(queries.some(({ text }) => text.includes("INSERT INTO project_decisions"))).toBe(false);
    expect(queries.at(-1)?.text).toBe("ROLLBACK");
  });
});

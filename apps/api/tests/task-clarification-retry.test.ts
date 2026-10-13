import { describe, expect, it } from "vitest";
import type { SessionIdentity } from "../src/auth.js";
import type { TaskDatabase } from "../src/task-database.js";
import { planningRunKey, type TaskModelGateway } from "../src/task-intake.js";
import { createTaskPlanningService } from "../src/task-service.js";
import { createTicketCipher } from "../src/ticket-crypto.js";

const taskId = "40000000-0000-4000-8000-000000000001";
const projectId = "20000000-0000-4000-8000-000000000001";
const session: SessionIdentity = { userId: "10000000-0000-4000-8000-000000000001", organizationId: "00000000-0000-4000-8000-000000000001", expiresAtMs: Date.now() + 60_000 };
const cipher = createTicketCipher("test-task-ticket-secret-that-is-long-enough-12345");
const codeReader = { readContext: async () => ({ text: "ctx", source: "upload" as const, revision: "50000000-0000-4000-8000-000000000001" }) };

class KeyGateway implements TaskModelGateway {
  readonly started: string[] = [];
  readonly calls: string[] = [];
  constructor(private readonly response: unknown) {}
  async startTaskRun(key: string): Promise<void> { this.started.push(key); }
  async call(key: string, purpose: string): Promise<unknown> {
    this.calls.push(`${key}:${purpose}`);
    if (this.response instanceof Error) throw this.response;
    return this.response;
  }
  async finishTaskRun(): Promise<void> {}
  takeCostRecords(key: string) { return [{ idempotencyKey: `${key}:clarify` }] as never; }
}

function database(overrides: Partial<TaskDatabase> = {}) {
  const recorded: Array<{ taskId: string; key: string }> = [];
  const saved: string[] = [];
  const db = {
    createTask: async () => ({ taskId }),
    beginClarificationRetry: async () => ({ projectId, maskedTicket: "refund wrong", planningAttempt: 2 }),
    recordModelCall: async (_s: SessionIdentity, id: string, cost: { idempotencyKey: string }) => { recorded.push({ taskId: id, key: cost.idempotencyKey }); },
    saveClarification: async (_s: SessionIdentity, id: string) => { saved.push(id); },
    ...overrides,
  } as unknown as TaskDatabase;
  return { db, recorded, saved };
}

describe("planningRunKey", () => {
  it("keeps the original run for attempt 1 and gives retries their own run", () => {
    expect(planningRunKey(taskId, 1)).toBe(taskId);
    expect(planningRunKey(taskId, 2)).toBe(`${taskId}:attempt-2`);
    expect(() => planningRunKey(taskId, 0)).toThrow();
  });
});

describe("retryClarification", () => {
  it("reruns clarify on a fresh gateway run and records costs against the real task", async () => {
    const gateway = new KeyGateway({ jobType: "bug_fix", questions: [{ question: "Should partial returns refund each unit?", suggestedAnswer: "Yes." }] });
    const { db, recorded, saved } = database();
    await createTaskPlanningService({ database: db, codeReader: codeReader as never, gateway, cipher, modelBudgetUsd: 1 }).retryClarification(session, taskId);
    expect(gateway.started).toEqual([`${taskId}:attempt-2`]);
    expect(gateway.calls).toEqual([`${taskId}:attempt-2:clarify`]);
    expect(recorded).toEqual([{ taskId, key: `${taskId}:attempt-2:clarify` }]);
    expect(saved).toEqual([taskId]);
  });

  it("refuses when the database says retry is not allowed", async () => {
    const gateway = new KeyGateway({});
    const { db } = database({ beginClarificationRetry: async () => { throw new Error("TASK_RETRY_NOT_ALLOWED"); } });
    await expect(createTaskPlanningService({ database: db, codeReader: codeReader as never, gateway, cipher, modelBudgetUsd: 1 }).retryClarification(session, taskId)).rejects.toThrow("TASK_RETRY_NOT_ALLOWED");
    expect(gateway.started).toEqual([]);
  });
});

describe("create when clarification fails", () => {
  it("carries the created task id so the requester lands on the draft to retry", async () => {
    const gateway = new KeyGateway(new Error("model unavailable"));
    const { db } = database();
    let caught: unknown;
    try {
      await createTaskPlanningService({ database: db, codeReader: codeReader as never, gateway, cipher, modelBudgetUsd: 1 }).create(session, projectId, "refund wrong");
    } catch (error) { caught = error; }
    expect((caught as Error).message).toBe("model unavailable");
    expect((caught as { taskId?: string }).taskId).toBe(taskId);
  });
});

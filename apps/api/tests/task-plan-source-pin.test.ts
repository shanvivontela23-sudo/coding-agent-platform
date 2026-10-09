import { describe, expect, it } from "vitest";
import type { SessionIdentity } from "../src/auth.js";
import type { ProjectCodeReader } from "../src/project-code-reader.js";
import type { TaskDatabase, TaskDetail } from "../src/task-database.js";
import type { TaskModelGateway } from "../src/task-intake.js";
import { createTaskPlanningService } from "../src/task-service.js";
import { createTicketCipher } from "../src/ticket-crypto.js";

const organizationId = "00000000-0000-4000-8000-000000000221";
const userId = "10000000-0000-4000-8000-000000000221";
const taskId = "40000000-0000-4000-8000-000000000221";
const projectId = "20000000-0000-4000-8000-000000000221";
const session: SessionIdentity = { userId, organizationId, expiresAtMs: Date.now() + 60_000 };
const cipher = createTicketCipher("task-plan-pin-test-secret-that-is-long-enough-12345");

function task(): TaskDetail {
  return {
    id: taskId,
    projectId,
    projectName: "Demo",
    repositoryId: "30000000-0000-4000-8000-000000000221",
    status: "waiting_for_answers",
    requestedByUserId: userId,
    maskedTicket: "Fix retry behavior",
    updatedAt: new Date().toISOString(),
    jobType: "bug_fix",
    whatIUnderstand: null,
    proposedApproach: null,
    jobSize: null,
    estimatedCostUsd: null,
    estimatedTimeMinutes: null,
    estimatedCostUsdMin: null,
    estimatedCostUsdMax: null,
    estimatedTimeMinutesMin: null,
    estimatedTimeMinutesMax: null,
    clarificationFilteredCount: 0,
    clarificationRephrasedCount: 0,
    confirmedRequirement: null,
    confirmedPlan: null,
    modelBudgetUsd: 0.5,
    originalTicketEncrypted: cipher.encrypt("Fix retry behavior"),
    questions: [],
    currentUserRole: "rep",
  };
}

class RecordedGateway implements TaskModelGateway {
  private readonly responses: unknown[] = [
    { jobType: "bug_fix", questions: [] },
    {
      whatIUnderstand: "Retry fails after a save error.",
      proposedApproach: "Preserve the retry state and cover the failure path.",
      size: "small",
    },
  ];
  async startTaskRun(): Promise<void> {}
  async call(): Promise<unknown> {
    const response = this.responses.shift();
    if (response === undefined) throw new Error("missing response");
    return response;
  }
  async finishTaskRun(): Promise<void> {}
}

describe("task plan source pin", () => {
  it("pins the exact GitHub commit read for planning, not an earlier report or clarification read", async () => {
    const clarificationCommit = "a".repeat(40);
    const planningCommit = "b".repeat(40);
    let reads = 0;
    const codeReader = {
      async readContext() {
        reads += 1;
        const commitSha = reads === 1 ? clarificationCommit : planningCommit;
        return {
          source: "github" as const,
          revision: commitSha,
          text: `source at ${commitSha}`,
          pin: { source: "github" as const, commitSha },
        };
      },
    } as unknown as ProjectCodeReader;

    let savedPin: unknown;
    const database = {
      async createTask() { return { taskId }; },
      async saveClarification() {},
      async unresolvedQuestionCount() { return 0; },
      async getTask() { return task(); },
      async savePlan(_session: SessionIdentity, _taskId: string, _plan: unknown, pin?: unknown) { savedPin = pin; },
      async recordModelCall() {},
    } as unknown as TaskDatabase;

    const service = createTaskPlanningService({
      database,
      codeReader,
      gateway: new RecordedGateway(),
      cipher,
      modelBudgetUsd: 0.5,
    });
    await service.create(session, projectId, "Fix retry behavior");

    expect(reads).toBe(2);
    expect(savedPin).toEqual({ source: "github", commitSha: planningCommit });
  });
});

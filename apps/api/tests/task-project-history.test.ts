import { describe, expect, it, vi } from "vitest";
import type { SessionIdentity } from "../src/auth.js";
import type { ProjectDecisionDatabase } from "../src/project-decision-database.js";
import type { ProjectCodeReader } from "../src/project-code-reader.js";
import type { TaskDatabase, TaskDetail } from "../src/task-database.js";
import type { PromptMessage, TaskModelGateway } from "../src/task-intake.js";
import { createTaskPlanningService } from "../src/task-service.js";
import { createTicketCipher } from "../src/ticket-crypto.js";

const session: SessionIdentity = { organizationId: "00000000-0000-4000-8000-000000000621", userId: "10000000-0000-4000-8000-000000000621", expiresAtMs: Date.now() + 60_000 };
const projectId = "20000000-0000-4000-8000-000000000621";
const taskId = "40000000-0000-4000-8000-000000000621";
const cipher = createTicketCipher("project-history-test-secret-at-least-32-characters");

function task(): TaskDetail {
  return {
    planningAttempt: 1, id: taskId, projectId, projectName: "Demo", repositoryId: null, status: "plan_ready", requestedByUserId: session.userId,
    maskedTicket: "Fix retry for [MASKED_EMAIL]", updatedAt: "2026-10-14T00:00:00.000Z", jobType: "change", whatIUnderstand: null,
    proposedApproach: null, jobSize: null, estimatedCostUsd: null, estimatedTimeMinutes: null, estimatedCostUsdMin: null, estimatedCostUsdMax: null,
    estimatedTimeMinutesMin: null, estimatedTimeMinutesMax: null, clarificationFilteredCount: 0, clarificationRephrasedCount: 0,
    confirmedRequirement: null, confirmedPlan: null, modelBudgetUsd: 0.5, originalTicketEncrypted: null, questions: [], currentUserRole: "rep",
  };
}

function setup(retry = false) {
  const calls: Array<{ purpose: string; messages: readonly PromptMessage[] }> = [];
  const responses: unknown[] = [
    { jobType: "change", questions: [] },
    { whatIUnderstand: "Keep retries reliable.", proposedApproach: "Use the established project convention.", size: "small" },
  ];
  const gateway: TaskModelGateway = {
    startTaskRun: async () => undefined,
    call: async (_taskId, purpose, messages) => { calls.push({ purpose, messages }); return responses.shift(); },
    finishTaskRun: async () => undefined,
    takeCostRecords: () => [],
  };
  const database = {
    createTask: vi.fn(async () => ({ taskId })),
    saveClarification: vi.fn(async () => undefined),
    unresolvedQuestionCount: vi.fn(async () => 0),
    getTask: vi.fn(async () => task()),
    savePlan: vi.fn(async () => undefined),
    recordModelCall: vi.fn(async () => undefined),
    beginClarificationRetry: vi.fn(async () => retry ? { projectId, maskedTicket: "Fix retry", planningAttempt: 2 } : null),
  } as unknown as TaskDatabase;
  const codeReader = { readContext: vi.fn(async () => ({ source: "github" as const, revision: "a".repeat(40), text: "repo facts", report: { languages: [], frameworks: [], packageManager: null, installCommand: null, buildCommand: null, testCommand: null, stackSkill: "generic", manifests: [] } })) } satisfies ProjectCodeReader;
  const projectDecisions = {
    listCurrent: vi.fn(async () => [{ id: "50000000-0000-4000-8000-000000000621", organizationId: session.organizationId, projectId, taskId: null, kind: "convention" as const, summary: "Tests live beside source", detail: {}, source: "verification" as const, createdAt: "2026-10-14T00:00:00.000Z", supersededBy: null }]),
  } as Pick<ProjectDecisionDatabase, "listCurrent">;
  const service = createTaskPlanningService({ database, projectDecisions, codeReader, gateway, cipher, modelBudgetUsd: 0.5 });
  return { calls, database, projectDecisions, service };
}

function expectHistoryOnlyInUser(messages: readonly PromptMessage[]): void {
  expect(messages[0]?.role).toBe("system");
  expect(messages[0]?.content).not.toContain("Tests live beside source");
  expect(messages[1]?.role).toBe("user");
  expect(messages[1]?.content).toContain("<PROJECT_HISTORY>");
  expect(messages[1]?.content).toContain("Tests live beside source");
}

describe("task project history", () => {
  it("loads bounded project history for clarification and immediate planning", async () => {
    const { calls, projectDecisions, service } = setup();
    await service.create(session, projectId, "Fix retry");
    expect(calls.map((call) => call.purpose)).toEqual(["clarify", "plan"]);
    for (const call of calls) expectHistoryOnlyInUser(call.messages);
    expect(projectDecisions.listCurrent).toHaveBeenCalledTimes(2);
    expect(projectDecisions.listCurrent).toHaveBeenCalledWith(session, projectId, 15);
  });

  it("reloads current project history for a clarification retry", async () => {
    const { calls, projectDecisions, service } = setup(true);
    await service.retryClarification(session, taskId);
    expect(calls.map((call) => call.purpose)).toEqual(["clarify", "plan"]);
    for (const call of calls) expectHistoryOnlyInUser(call.messages);
    expect(projectDecisions.listCurrent).toHaveBeenCalledTimes(2);
  });
});

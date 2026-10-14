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
    planningAttempt: 1,
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
  readonly systemMessages = new Map<string, string>();
  private readonly responses: unknown[] = [
    { jobType: "bug_fix", questions: [] },
    {
      whatIUnderstand: "Retry fails after a save error.",
      proposedApproach: "Preserve the retry state and cover the failure path.",
      size: "small",
    },
  ];
  async startTaskRun(): Promise<void> {}
  async call(_taskId: string, purpose: string, messages: readonly { readonly role: "system" | "user"; readonly content: string }[]): Promise<unknown> {
    this.systemMessages.set(purpose, messages[0]?.content ?? "");
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
          report: { languages: [], frameworks: [], packageManager: "pnpm", installCommand: "pnpm install --frozen-lockfile", buildCommand: null, testCommand: "pnpm test", stackSkill: "typescript-node", stackSkillVersion: "1.0.0", manifests: ["package.json", "pnpm-lock.yaml"] },
          pin: { source: "github" as const, commitSha },
        };
      },
    } as unknown as ProjectCodeReader;

    let savedPin: unknown;
    let savedSkill: unknown;
    const database = {
      async createTask() { return { taskId }; },
      async saveClarification() {},
      async unresolvedQuestionCount() { return 0; },
      async getTask() { return task(); },
      async savePlan(_session: SessionIdentity, _taskId: string, _plan: unknown, pin?: unknown, skill?: unknown) { savedPin = pin; savedSkill = skill; },
      async recordModelCall() {},
    } as unknown as TaskDatabase;

    const gateway = new RecordedGateway();
    const service = createTaskPlanningService({
      database,
      codeReader,
      gateway,
      cipher,
      modelBudgetUsd: 0.5,
    });
    await service.create(session, projectId, "Fix retry behavior");

    expect(reads).toBe(2);
    expect(savedPin).toEqual({ source: "github", commitSha: planningCommit });
    expect(savedSkill).toEqual({ id: "typescript-node", version: "1.0.0" });
    expect(gateway.systemMessages.get("clarify")).toContain("TypeScript / Node");
    expect(gateway.systemMessages.get("clarify")).not.toContain("Work with the repository's existing Node.js package manager");
    expect(gateway.systemMessages.get("plan")).toContain("Work with the repository's existing Node.js package manager");
  });
  it("records no planning skill and adds no guide for a generic project", async () => {
    const codeReader = {
      async readContext() {
        return { source: "github" as const, revision: "c".repeat(40), text: "source", report: { languages: [], frameworks: [], packageManager: null, installCommand: null, buildCommand: null, testCommand: null, stackSkill: "generic", manifests: [] } };
      },
    } as unknown as ProjectCodeReader;
    let savedSkill: unknown = "unset";
    const database = {
      async createTask() { return { taskId }; },
      async saveClarification() {},
      async unresolvedQuestionCount() { return 0; },
      async getTask() { return task(); },
      async savePlan(_session: SessionIdentity, _taskId: string, _plan: unknown, _pin?: unknown, skill?: unknown) { savedSkill = skill; },
      async recordModelCall() {},
    } as unknown as TaskDatabase;
    const gateway = new RecordedGateway();
    await createTaskPlanningService({ database, codeReader, gateway, cipher, modelBudgetUsd: 0.5 }).create(session, projectId, "Fix retry behavior");
    expect(savedSkill).toBeNull();
    expect(gateway.systemMessages.get("plan")).not.toContain("TRUSTED_STACK_SKILL");
    expect(gateway.systemMessages.get("clarify")).not.toContain("Stack:");
  });
});

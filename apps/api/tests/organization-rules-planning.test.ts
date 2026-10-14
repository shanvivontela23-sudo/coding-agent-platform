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
  readonly userMessages = new Map<string, string>();
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
    this.userMessages.set(purpose, messages[1]?.content ?? "");
    const response = this.responses.shift();
    if (response === undefined) throw new Error("missing response");
    return response;
  }
  async finishTaskRun(): Promise<void> {}
}

describe("organization rules in planning", () => {
  it("adds applicable rules to the plan prompt as untrusted user content only", async () => {
    const codeReader = {
      async readContext() {
        return { source: "github" as const, revision: "c".repeat(40), text: "source", report: { languages: [], frameworks: [], packageManager: "pnpm", installCommand: null, buildCommand: null, testCommand: "pnpm test", stackSkill: "typescript-node", stackSkillVersion: "1.0.0", manifests: ["package.json"] } };
      },
    } as unknown as ProjectCodeReader;
    const database = {
      async createTask() { return { taskId }; },
      async saveClarification() {},
      async unresolvedQuestionCount() { return 0; },
      async getTask() { return task(); },
      async savePlan() {},
      async recordModelCall() {},
    } as unknown as TaskDatabase;
    const rule = (id: string, title: string, appliesToStacks: string[] | null, enabled = true) => ({ id, title, body: `${title} body`, appliesToStacks, enabled, updatedAt: "2026-10-14T00:00:00.000Z" });
    const organizationSkills = { list: async () => [
      rule("80000000-0000-4000-8000-000000000001", "Update the changelog", null),
      rule("80000000-0000-4000-8000-000000000002", "Python only", ["python"]),
      rule("80000000-0000-4000-8000-000000000003", "Turned off", null, false),
    ] };
    const gateway = new RecordedGateway();
    await createTaskPlanningService({ database, codeReader, gateway, cipher, modelBudgetUsd: 0.5, organizationSkills }).create(session, projectId, "Fix retry behavior");
    const planUser = gateway.userMessages.get("plan") ?? "";
    expect(planUser).toContain("<ORGANIZATION_RULES>\n- Update the changelog: Update the changelog body\n</ORGANIZATION_RULES>");
    expect(planUser).not.toContain("Python only");
    expect(planUser).not.toContain("Turned off");
    expect(planUser.indexOf("<ORGANIZATION_RULES>")).toBeLessThan(planUser.indexOf("<UNTRUSTED_ANSWERS>"));
    expect(gateway.systemMessages.get("plan")).not.toContain("ORGANIZATION_RULES");
    expect(gateway.userMessages.get("clarify")).not.toContain("ORGANIZATION_RULES");
  });
});

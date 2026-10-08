import { describe, expect, it } from "vitest";
import type { SessionIdentity } from "../src/auth.js";
import type { ProjectCodeReader } from "../src/project-code-reader.js";
import type { TaskDatabase, TaskDetail } from "../src/task-database.js";
import type { TaskModelGateway } from "../src/task-intake.js";
import { createTaskService } from "../src/task-service.js";
import { createTicketCipher } from "../src/ticket-crypto.js";

const cipher = createTicketCipher("test-task-ticket-secret-that-is-long-enough-12345");
const repId = "10000000-0000-4000-8000-000000000001";
const orgId = "00000000-0000-4000-8000-000000000001";

function identity(userId: string): SessionIdentity { return { userId, organizationId: orgId, expiresAtMs: Date.now() + 60_000 }; }
function detail(role: TaskDetail["currentUserRole"]): TaskDetail {
  return {
    id: "40000000-0000-4000-8000-000000000001",
    projectId: "20000000-0000-4000-8000-000000000001",
    projectName: "Demo",
    repositoryId: "30000000-0000-4000-8000-000000000001",
    status: "waiting_for_answers",
    requestedByUserId: repId,
    maskedTicket: "Customer [MASKED_NAME] needs a retry",
    updatedAt: new Date().toISOString(),
    jobType: "bug_fix",
    whatIUnderstand: null,
    proposedApproach: null,
    jobSize: null,
    estimatedCostUsd: null,
    estimatedTimeMinutes: null,
    confirmedRequirement: null,
    confirmedPlan: null,
    modelBudgetUsd: 0.5,
    originalTicketEncrypted: cipher.encrypt("Customer Jane Doe needs a retry"),
    questions: [],
    currentUserRole: role,
  };
}
const codeReader = { readContext: async () => ({ source: "github" as const, revision: "a".repeat(40), text: "" }) } satisfies ProjectCodeReader;
const gateway: TaskModelGateway = { startTaskRun: async () => {}, call: async () => ({}), finishTaskRun: async () => {} };

describe("task original-ticket visibility", () => {
  it("returns decrypted original only to the requesting support rep", async () => {
    let role: TaskDetail["currentUserRole"] = "rep";
    const database = { getTask: async () => detail(role) } as unknown as TaskDatabase;
    const service = createTaskService({ database, codeReader, gateway, cipher, modelBudgetUsd: 0.5 });

    const requester = await service.get(identity(repId), "40000000-0000-4000-8000-000000000001");
    expect(requester?.originalTicket).toBe("Customer Jane Doe needs a retry");

    role = "developer";
    const developer = await service.get(identity("10000000-0000-4000-8000-000000000002"), "40000000-0000-4000-8000-000000000001");
    expect(developer).not.toHaveProperty("originalTicket");

    role = "owner";
    const owner = await service.get(identity("10000000-0000-4000-8000-000000000003"), "40000000-0000-4000-8000-000000000001");
    expect(owner).not.toHaveProperty("originalTicket");
  });
});

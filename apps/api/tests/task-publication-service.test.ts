import { describe, expect, it, vi } from "vitest";
import { createTaskPublicationService } from "../src/task-publication-service.js";

const session = { userId: "10000000-0000-4000-8000-000000000601", organizationId: "00000000-0000-4000-8000-000000000601", expiresAtMs: Date.now() + 60_000 };
const taskId = "40000000-0000-4000-8000-000000000601";
const base = {
  executionId: "50000000-0000-4000-8000-000000000601",
  executionStatus: "succeeded",
  currentUserRole: "developer",
  repositoryFullName: "acme/demo",
  defaultBranch: "main",
  approvedSha: "a".repeat(40),
  approvedPlan: "Update `src/retry.ts`.",
  patch: "diff --git a/src/retry.ts b/src/retry.ts\n--- a/src/retry.ts\n+++ b/src/retry.ts\n@@ -1 +1 @@\n-old\n+new\n",
  changeDocument: "## What was asked\nFix retry",
};

function setup(overrides: Record<string, unknown> = {}) {
  const context = { ...base, ...overrides };
  const database = {
    getPublishContext: vi.fn(async () => context),
    markPublishing: vi.fn(async () => undefined),
    markPublished: vi.fn(async (_session: typeof session, _taskId: string, result: unknown) => result),
    markSourceChanged: vi.fn(async (_session: typeof session, _taskId: string, result: unknown) => result),
    markFailed: vi.fn(async (_session: typeof session, _taskId: string, failure: unknown) => failure),
  };
  const publisher = {
    publish: vi.fn(async () => ({ status: "published" as const, branchName: "dhara/execution-x", baseMovedCommits: 2, currentHeadSha: "b".repeat(40), branchHeadSha: "c".repeat(40), pullRequestNumber: 7, pullRequestUrl: "https://github.com/acme/demo/pull/7" })),
  };
  return { database, publisher, service: createTaskPublicationService({ database, publisher }) };
}

describe("task publication service", () => {
  it("allows only developers and owners to publish", async () => {
    const { service, publisher } = setup({ currentUserRole: "rep" });
    await expect(service.publish(session, taskId)).rejects.toMatchObject({ code: "TASK_PUBLICATION_FORBIDDEN" });
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it("publishes succeeded and explicit fix_not_reproduced executions, marking the latter unproven", async () => {
    const succeeded = setup();
    await succeeded.service.publish(session, taskId);
    expect(succeeded.publisher.publish).toHaveBeenCalledWith(expect.objectContaining({ unproven: false }));

    const unproven = setup({ executionStatus: "fix_not_reproduced", currentUserRole: "owner" });
    await unproven.service.publish(session, taskId);
    expect(unproven.publisher.publish).toHaveBeenCalledWith(expect.objectContaining({ unproven: true }));
  });

  it.each(["verification_failed", "verification_incomplete"])("never publishes %s", async (executionStatus) => {
    const { service, publisher } = setup({ executionStatus });
    await expect(service.publish(session, taskId)).rejects.toMatchObject({ code: "TASK_PUBLICATION_NOT_ALLOWED" });
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it("records a retryable publication failure without starting a new paid execution", async () => {
    const { database, publisher, service } = setup();
    publisher.publish.mockRejectedValueOnce(new Error("temporary GitHub failure"));
    await expect(service.publish(session, taskId)).rejects.toMatchObject({ code: "TASK_PUBLICATION_FAILED" });
    expect(database.markFailed).toHaveBeenCalledTimes(1);

    await expect(service.publish(session, taskId)).resolves.toBeDefined();
    expect(publisher.publish).toHaveBeenCalledTimes(2);
    expect(database.getPublishContext).toHaveBeenCalledTimes(2);
  });
});

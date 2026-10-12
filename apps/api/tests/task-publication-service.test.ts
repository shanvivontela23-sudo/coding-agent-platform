import { describe, expect, it, vi } from "vitest";
import { TaskPublicationInProgressError, createTaskPublicationService, type TaskPublishContext } from "../src/task-publication-service.js";

const session = { userId: "10000000-0000-4000-8000-000000000601", organizationId: "00000000-0000-4000-8000-000000000601", expiresAtMs: Date.now() + 60_000 };
const taskId = "40000000-0000-4000-8000-000000000601";
const base: TaskPublishContext = {
  executionId: "50000000-0000-4000-8000-000000000601",
  executionStatus: "succeeded",
  currentUserRole: "developer",
  repositoryFullName: "acme/demo",
  defaultBranch: "main",
  installationId: 777,
  approvedSha: "a".repeat(40),
  approvedPlan: "Update `src/retry.ts`.",
  patch: "diff --git a/src/retry.ts b/src/retry.ts\n--- a/src/retry.ts\n+++ b/src/retry.ts\n@@ -1 +1 @@\n-old\n+new\n",
  changeDocument: "## What was asked\nFix retry",
  verifiedFiles: [{ path: "src/retry.ts", blobSha: "d".repeat(40), mode: "100644", deleted: false }],
};

type ExistingPublication = { readonly status: "published"; readonly pullRequestUrl: string; readonly executionId: string } | null;
function setup(overrides: Partial<TaskPublishContext> = {}, existing: ExistingPublication = null) {
  const context: TaskPublishContext = { ...base, ...overrides };
  const publishingRecord = { status: "publishing", executionId: context.executionId, branchName: `dhara/execution-${context.executionId}` };
  const database = {
    getPublishContext: vi.fn(async () => context),
    getLatest: vi.fn(async () => existing),
    markPublishing: vi.fn(async () => ({ state: "acquired" as const, record: publishingRecord })),
    markPublished: vi.fn(async (_session: typeof session, _taskId: string, result: unknown) => result),
    markSourceChanged: vi.fn(async (_session: typeof session, _taskId: string, result: unknown) => result),
    markFailed: vi.fn(async (_session: typeof session, _taskId: string, failure: unknown) => failure),
  };
  const publisher = {
    publish: vi.fn(async () => ({ status: "published" as const, branchName: "dhara/execution-x", baseMovedCommits: 2, currentHeadSha: "b".repeat(40), branchHeadSha: "c".repeat(40), pullRequestNumber: 7, pullRequestUrl: "https://github.com/acme/demo/pull/7" })),
  };
  const githubApp = { getInstallationPermissions: vi.fn(async () => ({ contents: "write" as const })) };
  return { database, publisher, githubApp, service: createTaskPublicationService({ database, publisher, githubApp }) };
}

describe("task publication service", () => {
  it("allows only developers and owners to publish", async () => {
    const { service, publisher } = setup({ currentUserRole: "rep" });
    await expect(service.publish(session, taskId)).rejects.toMatchObject({ code: "TASK_PUBLICATION_FORBIDDEN" });
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it("re-checks Contents write without the permission cache at Publish", async () => {
    const { service, githubApp } = setup();
    await service.publish(session, taskId);
    expect(githubApp.getInstallationPermissions).toHaveBeenCalledWith(777, { bypassCache: true });
  });

  it("publishes succeeded and explicit fix_not_reproduced executions, marking the latter unproven", async () => {
    const succeeded = setup();
    await succeeded.service.publish(session, taskId);
    expect(succeeded.publisher.publish).toHaveBeenCalledWith(expect.objectContaining({ unproven: false, verifiedFiles: base.verifiedFiles }));

    const unproven = setup({ executionStatus: "fix_not_reproduced", currentUserRole: "owner" });
    await unproven.service.publish(session, taskId);
    expect(unproven.publisher.publish).toHaveBeenCalledWith(expect.objectContaining({ unproven: true }));
  });

  it.each(["verification_failed", "verification_incomplete"])("never publishes %s", async (executionStatus) => {
    const { service, publisher } = setup({ executionStatus });
    await expect(service.publish(session, taskId)).rejects.toMatchObject({ code: "TASK_PUBLICATION_NOT_ALLOWED" });
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it("returns 409 semantics when another request already owns publishing", async () => {
    const { service, database, publisher } = setup();
    const record = { status: "publishing", executionId: base.executionId };
    database.markPublishing.mockResolvedValueOnce({ state: "publishing", record });
    await expect(service.publish(session, taskId)).rejects.toEqual(expect.objectContaining({ code: "TASK_PUBLICATION_IN_PROGRESS", status: 409, publicMessage: "Publishing is already in progress", publication: record } satisfies Partial<TaskPublicationInProgressError>));
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

  it("returns an already published result without touching GitHub again", async () => {
    const existing = { status: "published" as const, pullRequestUrl: "https://github.com/acme/demo/pull/9", executionId: base.executionId };
    const { service, publisher, database, githubApp } = setup({}, existing);
    await expect(service.publish(session, taskId)).resolves.toEqual(existing);
    expect(publisher.publish).not.toHaveBeenCalled();
    expect(database.markPublishing).not.toHaveBeenCalled();
    expect(githubApp.getInstallationPermissions).not.toHaveBeenCalled();
  });
});

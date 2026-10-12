import type { SessionIdentity } from "./auth.js";
import { AppError } from "./errors.js";
import type { GitHubExecutionPublisher, PublicationResult } from "./github-publication.js";

export type TaskPublishContext = {
  readonly executionId: string;
  readonly executionStatus: string;
  readonly currentUserRole: "owner" | "developer" | "rep";
  readonly repositoryFullName: string;
  readonly defaultBranch: string;
  readonly approvedSha: string;
  readonly approvedPlan: string;
  readonly patch: string;
  readonly changeDocument: string;
};

export interface TaskPublicationDatabase {
  getPublishContext(session: SessionIdentity, taskId: string): Promise<TaskPublishContext | null>;
  markPublishing(session: SessionIdentity, taskId: string, input: { readonly executionId: string; readonly branchName: string; readonly unproven: boolean }): Promise<void>;
  markPublished(session: SessionIdentity, taskId: string, result: Extract<PublicationResult, { status: "published" }>): Promise<unknown>;
  markSourceChanged(session: SessionIdentity, taskId: string, result: Extract<PublicationResult, { status: "source_changed" }>): Promise<unknown>;
  markFailed(session: SessionIdentity, taskId: string, failure: { readonly executionId: string; readonly code: string; readonly message: string }): Promise<unknown>;
  getLatest?(session: SessionIdentity, taskId: string): Promise<unknown>;
}

export interface TaskPublicationService {
  get(session: SessionIdentity, taskId: string): Promise<unknown>;
  publish(session: SessionIdentity, taskId: string): Promise<unknown>;
}

export function createTaskPublicationService(options: {
  readonly database: TaskPublicationDatabase;
  readonly publisher: Pick<GitHubExecutionPublisher, "publish">;
}): TaskPublicationService {
  return {
    async get(session, taskId) { return options.database.getLatest ? await options.database.getLatest(session, taskId) : null; },
    async publish(session, taskId) {
      const context = await options.database.getPublishContext(session, taskId);
      if (!context) throw new AppError("TASK_PUBLICATION_NOT_FOUND", "No implementation result is available to publish.", 404);
      if (context.currentUserRole !== "developer" && context.currentUserRole !== "owner") throw new AppError("TASK_PUBLICATION_FORBIDDEN", "Only a developer or owner can publish this implementation.", 403);
      if (context.executionStatus !== "succeeded" && context.executionStatus !== "fix_not_reproduced") throw new AppError("TASK_PUBLICATION_NOT_ALLOWED", "This implementation result cannot be published.", 409);
      const unproven = context.executionStatus === "fix_not_reproduced";
      const branchName = `dhara/execution-${context.executionId.toLowerCase()}`;
      await options.database.markPublishing(session, taskId, { executionId: context.executionId, branchName, unproven });
      try {
        const result = await options.publisher.publish({
          executionId: context.executionId,
          repositoryFullName: context.repositoryFullName,
          defaultBranch: context.defaultBranch,
          approvedSha: context.approvedSha,
          approvedPlan: context.approvedPlan,
          patch: context.patch,
          changeDocument: context.changeDocument,
          unproven,
        });
        return result.status === "published"
          ? await options.database.markPublished(session, taskId, result)
          : await options.database.markSourceChanged(session, taskId, result);
      } catch {
        const failure = { executionId: context.executionId, code: "GITHUB_PUBLICATION_FAILED", message: "GitHub publication failed. Retry publication without starting a new implementation attempt." };
        await options.database.markFailed(session, taskId, failure);
        throw new AppError("TASK_PUBLICATION_FAILED", failure.message, 502);
      }
    },
  };
}

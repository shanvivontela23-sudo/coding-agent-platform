import type { SessionIdentity } from "./auth.js";
import { AppError } from "./errors.js";
import type { GitHubInstallationPermissionReader } from "./github-installation-permissions.js";
import type { GitHubExecutionPublisher, PublicationResult } from "./github-publication.js";
import type { VerifiedFile } from "../../worker/src/verification.js";

export type TaskPublishContext = {
  readonly executionId: string;
  readonly executionStatus: string;
  readonly currentUserRole: "owner" | "developer" | "rep";
  readonly repositoryFullName: string;
  readonly defaultBranch: string;
  readonly installationId: number;
  readonly approvedSha: string;
  readonly approvedPlan: string;
  readonly patch: string;
  readonly changeDocument: string;
  readonly verifiedFiles: readonly VerifiedFile[];
};

export type PublicationClaim = {
  readonly state: "acquired" | "publishing" | "published";
  readonly record: unknown;
};

export interface TaskPublicationDatabase {
  getPublishContext(session: SessionIdentity, taskId: string): Promise<TaskPublishContext | null>;
  markPublishing(session: SessionIdentity, taskId: string, input: { readonly executionId: string; readonly branchName: string; readonly unproven: boolean }): Promise<PublicationClaim>;
  markPublished(session: SessionIdentity, taskId: string, result: Extract<PublicationResult, { status: "published" }>): Promise<unknown>;
  markSourceChanged(session: SessionIdentity, taskId: string, result: Extract<PublicationResult, { status: "source_changed" }>): Promise<unknown>;
  markFailed(session: SessionIdentity, taskId: string, failure: { readonly executionId: string; readonly code: string; readonly message: string }): Promise<unknown>;
  getLatest?(session: SessionIdentity, taskId: string): Promise<unknown>;
}

export interface TaskPublicationService {
  get(session: SessionIdentity, taskId: string): Promise<unknown>;
  publish(session: SessionIdentity, taskId: string): Promise<unknown>;
}

function isPublished(value: unknown): value is { readonly status: "published"; readonly executionId?: string } {
  return typeof value === "object" && value !== null && (value as { readonly status?: unknown }).status === "published";
}

export class TaskPublicationInProgressError extends AppError {
  constructor(readonly publication: unknown) {
    super("TASK_PUBLICATION_IN_PROGRESS", "Publishing is already in progress", 409);
  }
}

export function createTaskPublicationService(options: {
  readonly database: TaskPublicationDatabase;
  readonly publisher: Pick<GitHubExecutionPublisher, "publish">;
  readonly githubApp: GitHubInstallationPermissionReader;
}): TaskPublicationService {
  return {
    async get(session, taskId) { return options.database.getLatest ? await options.database.getLatest(session, taskId) : null; },
    async publish(session, taskId) {
      const context = await options.database.getPublishContext(session, taskId);
      if (!context) throw new AppError("TASK_PUBLICATION_NOT_FOUND", "No implementation result is available to publish.", 404);
      if (context.currentUserRole !== "developer" && context.currentUserRole !== "owner") throw new AppError("TASK_PUBLICATION_FORBIDDEN", "Only a developer or owner can publish this implementation.", 403);
      if (context.executionStatus !== "succeeded" && context.executionStatus !== "fix_not_reproduced") throw new AppError("TASK_PUBLICATION_NOT_ALLOWED", "This implementation result cannot be published.", 409);
      const existing = options.database.getLatest ? await options.database.getLatest(session, taskId) : null;
      if (isPublished(existing) && (!existing.executionId || existing.executionId === context.executionId)) return existing;

      const permissions = await options.githubApp.getInstallationPermissions(context.installationId, { bypassCache: true });
      if (permissions.contents !== "write") throw new AppError("GITHUB_CONTENTS_WRITE_REQUIRED", "GitHub App needs Repository permissions → Contents: Read and write before publishing.", 409);

      const unproven = context.executionStatus === "fix_not_reproduced";
      const branchName = `dhara/execution-${context.executionId.toLowerCase()}`;
      const claim = await options.database.markPublishing(session, taskId, { executionId: context.executionId, branchName, unproven });
      if (claim.state === "published") return claim.record;
      if (claim.state === "publishing") throw new TaskPublicationInProgressError(claim.record);

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
          verifiedFiles: context.verifiedFiles,
        });
        return result.status === "published"
          ? await options.database.markPublished(session, taskId, result)
          : await options.database.markSourceChanged(session, taskId, result);
      } catch (error) {
        if (error instanceof AppError && (error.code === "PUBLISHED_CONTENT_MISMATCH" || error.code === "TASK_PUBLICATION_NOT_ALLOWED")) {
          await options.database.markFailed(session, taskId, { executionId: context.executionId, code: error.code, message: error.publicMessage });
          throw error;
        }
        const failure = { executionId: context.executionId, code: "GITHUB_PUBLICATION_FAILED", message: "GitHub publication failed. Retry publication without starting a new implementation attempt." };
        await options.database.markFailed(session, taskId, failure);
        throw new AppError("TASK_PUBLICATION_FAILED", failure.message, 502);
      }
    },
  };
}

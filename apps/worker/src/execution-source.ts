import type { PinnedRepositoryArchive } from "../../../evals/src/sandbox/types.js";

export type ExecutionCommands = {
  readonly install: string | null;
  readonly test: string | null;
  readonly build: string | null;
};

export type PreparedExecutionSource = {
  readonly repository: PinnedRepositoryArchive;
  readonly jobType: string | null;
  readonly requirement: string;
  readonly plan: string;
  readonly commands: ExecutionCommands;
  readonly reviewFocus: string;
};

export interface ExecutionSourceProvider {
  prepare(input: {
    readonly organizationId: string;
    readonly taskId: string;
    readonly projectId: string;
    readonly sourceCommitSha: string | null;
    readonly sourceVersionId: string | null;
  }): Promise<PreparedExecutionSource>;
}

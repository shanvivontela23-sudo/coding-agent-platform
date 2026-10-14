import type { PinnedRepositoryArchive } from "../../../evals/src/sandbox/types.js";
import type { ExecutionProfile } from "../../../packages/skills/src/profile.js";
import type { StoredProjectReport } from "../../../packages/skills/src/resolution.js";

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
  // Facts used to resolve the execution profile once. After pinning, commands
  // above are replaced by the profile's and executionProfile is set; every later
  // stage reads only the pinned values.
  readonly report?: StoredProjectReport;
  readonly planningSkill?: { readonly id: string; readonly version: string } | null;
  readonly executionProfile?: ExecutionProfile;
};

export function applyExecutionProfile(source: PreparedExecutionSource, profile: ExecutionProfile): PreparedExecutionSource {
  return { ...source, commands: { install: profile.commands.install, test: profile.commands.test, build: profile.commands.build }, executionProfile: profile };
}

export interface ExecutionSourceProvider {
  prepare(input: {
    readonly organizationId: string;
    readonly taskId: string;
    readonly projectId: string;
    readonly sourceCommitSha: string | null;
    readonly sourceVersionId: string | null;
  }): Promise<PreparedExecutionSource>;
}

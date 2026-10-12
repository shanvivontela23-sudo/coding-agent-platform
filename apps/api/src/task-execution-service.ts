import type { SessionIdentity } from "./auth.js";
import { AppError } from "./errors.js";
import type { GitHubInstallationPermissionReader } from "./github-installation-permissions.js";
import type { TaskExecutionDatabase, TaskExecutionRecord } from "./task-execution-database.js";
import type { TaskExecutionReadinessReader } from "./task-execution-readiness.js";

export const REANALYSE_BEFORE_IMPLEMENTATION = "Re-analyse this project before implementation";
export const CONTENTS_WRITE_REQUIRED = "GitHub App needs Repository permissions → Contents: Read and write before implementation can start.";

export interface TaskExecutionService {
  get(session: SessionIdentity, taskId: string): Promise<TaskExecutionRecord | null>;
  readiness(session: SessionIdentity, taskId: string): Promise<{ readonly implementationBlocker: string | null }>;
  start(session: SessionIdentity, taskId: string): Promise<{ readonly execution: TaskExecutionRecord; readonly created: boolean }>;
  cancel(session: SessionIdentity, taskId: string): Promise<TaskExecutionRecord>;
}

export function createTaskExecutionService(options: {
  readonly database: TaskExecutionDatabase;
  readonly readinessReader: TaskExecutionReadinessReader;
  readonly githubApp: GitHubInstallationPermissionReader;
  readonly budgetUsd: number;
  readonly timeoutSeconds: number;
}): TaskExecutionService {
  if (!Number.isFinite(options.budgetUsd) || options.budgetUsd <= 0) throw new Error("execution budget must be greater than zero");
  if (!Number.isSafeInteger(options.timeoutSeconds) || options.timeoutSeconds <= 0) throw new Error("execution timeout must be a positive integer");

  const blocker = async (session: SessionIdentity, taskId: string): Promise<string | null> => {
    const readiness = await options.readinessReader.get(session, taskId);
    if (!readiness.reportHasInstallCommand) return REANALYSE_BEFORE_IMPLEMENTATION;
    if (readiness.githubInstallationId !== null) {
      const permissions = await options.githubApp.getInstallationPermissions(readiness.githubInstallationId);
      if (permissions.contents !== "write") return CONTENTS_WRITE_REQUIRED;
    }
    return null;
  };

  return {
    async get(session, taskId) { return await options.database.getLatest(session, taskId); },
    async readiness(session, taskId) { return { implementationBlocker: await blocker(session, taskId) }; },
    async start(session, taskId) {
      const implementationBlocker = await blocker(session, taskId);
      if (implementationBlocker === REANALYSE_BEFORE_IMPLEMENTATION) {
        throw new AppError("TASK_EXECUTION_REANALYSIS_REQUIRED", implementationBlocker, 409);
      }
      if (implementationBlocker) throw new AppError("GITHUB_CONTENTS_WRITE_REQUIRED", implementationBlocker, 409);
      return await options.database.start(session, taskId, { budgetUsd: options.budgetUsd, timeoutSeconds: options.timeoutSeconds });
    },
    async cancel(session, taskId) { return await options.database.cancel(session, taskId); },
  };
}

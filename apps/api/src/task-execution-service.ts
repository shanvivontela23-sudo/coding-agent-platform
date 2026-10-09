import type { SessionIdentity } from "./auth.js";
import type { TaskExecutionDatabase, TaskExecutionRecord } from "./task-execution-database.js";

export interface TaskExecutionService {
  get(session: SessionIdentity, taskId: string): Promise<TaskExecutionRecord | null>;
  start(session: SessionIdentity, taskId: string): Promise<{ readonly execution: TaskExecutionRecord; readonly created: boolean }>;
  cancel(session: SessionIdentity, taskId: string): Promise<TaskExecutionRecord>;
}

export function createTaskExecutionService(options: {
  readonly database: TaskExecutionDatabase;
  readonly budgetUsd: number;
  readonly timeoutSeconds: number;
}): TaskExecutionService {
  if (!Number.isFinite(options.budgetUsd) || options.budgetUsd <= 0) throw new Error("execution budget must be greater than zero");
  if (!Number.isSafeInteger(options.timeoutSeconds) || options.timeoutSeconds <= 0) throw new Error("execution timeout must be a positive integer");
  return {
    async get(session, taskId) { return await options.database.getLatest(session, taskId); },
    async start(session, taskId) { return await options.database.start(session, taskId, { budgetUsd: options.budgetUsd, timeoutSeconds: options.timeoutSeconds }); },
    async cancel(session, taskId) { return await options.database.cancel(session, taskId); },
  };
}

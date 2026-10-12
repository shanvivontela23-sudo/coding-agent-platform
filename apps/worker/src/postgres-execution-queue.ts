export type ClaimedExecution = {
  readonly executionId: string;
  readonly organizationId: string;
  readonly taskId: string;
  readonly projectId: string;
  readonly attempt: number;
  readonly sourceCommitSha: string | null;
  readonly sourceVersionId: string | null;
  readonly budgetUsd: number;
  readonly timeoutSeconds: number;
};

export type ExecutionFinishStatus = "succeeded" | "failed" | "verification_failed" | "fix_not_reproduced";
export type ExecutionControlState = "running" | "cancelled" | "timed_out" | "lost" | ExecutionFinishStatus;

export interface ExecutionQueue {
  claim(workerId: string, leaseSeconds: number): Promise<ClaimedExecution | null>;
  heartbeat(executionId: string, workerId: string, leaseSeconds: number): Promise<ExecutionControlState>;
  finish(executionId: string, workerId: string, status: ExecutionFinishStatus, failureCode?: string | null, failureMessage?: string | null): Promise<ExecutionControlState>;
}

export interface RestrictedQueryPool {
  query<Row = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<{ readonly rows: Row[] }>;
}

type ClaimRow = {
  execution_id: string;
  organization_id: string;
  task_id: string;
  project_id: string;
  attempt: number;
  source_commit_sha: string | null;
  source_version_id: string | null;
  budget_usd: string | number;
  timeout_seconds: number;
};

export class PostgresExecutionQueue implements ExecutionQueue {
  constructor(private readonly pool: RestrictedQueryPool) {}

  async claim(workerId: string, leaseSeconds: number): Promise<ClaimedExecution | null> {
    const result = await this.pool.query<ClaimRow>(
      "SELECT * FROM public.claim_task_execution($1,$2)",
      [workerId, leaseSeconds],
    );
    const row = result.rows[0];
    return row ? {
      executionId: row.execution_id,
      organizationId: row.organization_id,
      taskId: row.task_id,
      projectId: row.project_id,
      attempt: row.attempt,
      sourceCommitSha: row.source_commit_sha,
      sourceVersionId: row.source_version_id,
      budgetUsd: Number(row.budget_usd),
      timeoutSeconds: row.timeout_seconds,
    } : null;
  }

  async heartbeat(executionId: string, workerId: string, leaseSeconds: number): Promise<ExecutionControlState> {
    const result = await this.pool.query<{ heartbeat_task_execution: ExecutionControlState }>(
      "SELECT public.heartbeat_task_execution($1,$2,$3)",
      [executionId, workerId, leaseSeconds],
    );
    return result.rows[0]?.heartbeat_task_execution ?? "lost";
  }

  async finish(executionId: string, workerId: string, status: ExecutionFinishStatus, failureCode: string | null = null, failureMessage: string | null = null): Promise<ExecutionControlState> {
    const result = await this.pool.query<{ finish_task_execution: ExecutionControlState }>(
      "SELECT public.finish_task_execution($1,$2,$3,$4,$5)",
      [executionId, workerId, status, failureCode, failureMessage],
    );
    return result.rows[0]?.finish_task_execution ?? "lost";
  }
}

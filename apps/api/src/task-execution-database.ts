import type { SessionIdentity } from "./auth.js";
import { assertUuid, type MemberRole, type TenantPool, withTenant } from "./database.js";
import { AppError } from "./errors.js";

export type TaskExecutionStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out";

export type TaskExecutionRecord = {
  readonly id: string;
  readonly taskId: string;
  readonly projectId: string;
  readonly attempt: number;
  readonly status: TaskExecutionStatus;
  readonly startedByUserId: string;
  readonly sourceCommitSha: string | null;
  readonly sourceVersionId: string | null;
  readonly budgetUsd: number;
  readonly timeoutSeconds: number;
  readonly cancelRequestedAt: string | null;
  readonly queuedAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly failureCode: string | null;
  readonly failureMessage: string | null;
};

export interface TaskExecutionDatabase {
  getLatest(session: SessionIdentity, taskId: string): Promise<TaskExecutionRecord | null>;
  start(session: SessionIdentity, taskId: string, options: { readonly budgetUsd: number; readonly timeoutSeconds: number }): Promise<{ readonly execution: TaskExecutionRecord; readonly created: boolean }>;
  cancel(session: SessionIdentity, taskId: string): Promise<TaskExecutionRecord>;
}

type ExecutionRow = {
  id: string;
  task_id: string;
  project_id: string;
  attempt: number;
  status: TaskExecutionStatus;
  started_by_user_id: string;
  source_commit_sha: string | null;
  source_version_id: string | null;
  budget_usd: string | number;
  timeout_seconds: number;
  cancel_requested_at: Date | string | null;
  queued_at: Date | string;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  failure_code: string | null;
  failure_message: string | null;
};

type TaskControlRow = {
  task_id: string;
  project_id: string;
  status: string;
  requested_by_user_id: string;
  planned_source_commit_sha: string | null;
  planned_source_version_id: string | null;
  current_user_role: MemberRole;
};

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function execution(row: ExecutionRow): TaskExecutionRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    projectId: row.project_id,
    attempt: row.attempt,
    status: row.status,
    startedByUserId: row.started_by_user_id,
    sourceCommitSha: row.source_commit_sha,
    sourceVersionId: row.source_version_id,
    budgetUsd: Number(row.budget_usd),
    timeoutSeconds: row.timeout_seconds,
    cancelRequestedAt: iso(row.cancel_requested_at),
    queuedAt: iso(row.queued_at)!,
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    failureCode: row.failure_code,
    failureMessage: row.failure_message,
  };
}

const executionColumns = `id,task_id,project_id,attempt,status,started_by_user_id,source_commit_sha,source_version_id,budget_usd,timeout_seconds,cancel_requested_at,queued_at,started_at,finished_at,failure_code,failure_message`;

function canControl(row: TaskControlRow, session: SessionIdentity): boolean {
  return row.current_user_role === "owner" || row.current_user_role === "developer" || (row.current_user_role === "rep" && row.requested_by_user_id === session.userId);
}

async function taskControl(database: { query<Row>(text: string, values?: readonly unknown[]): Promise<{ rows: Row[] }> }, session: SessionIdentity, taskId: string): Promise<TaskControlRow> {
  const result = await database.query<TaskControlRow>(
    `SELECT t.id AS task_id,t.project_id,t.status,t.requested_by_user_id,t.planned_source_commit_sha,t.planned_source_version_id,m.role AS current_user_role
       FROM tasks t
       JOIN organization_memberships m ON m.organization_id=t.organization_id AND m.user_id=$3
      WHERE t.organization_id=$1 AND t.id=$2
      LIMIT 1`,
    [session.organizationId, taskId, session.userId],
  );
  const row = result.rows[0];
  if (!row) throw new AppError("TASK_EXECUTION_NOT_FOUND", "Task not found.", 404);
  return row;
}

function validateStart(row: TaskControlRow, session: SessionIdentity): void {
  if (!canControl(row, session)) throw new AppError("TASK_EXECUTION_FORBIDDEN", "You cannot start implementation for this task.", 403);
  if (row.status !== "approved") throw new AppError("TASK_EXECUTION_NOT_READY", "Approve the plan before starting implementation.", 409);
  if ((row.planned_source_commit_sha === null) === (row.planned_source_version_id === null)) {
    throw new AppError("TASK_EXECUTION_SOURCE_UNAVAILABLE", "The approved source is unavailable. Recreate the plan before starting implementation.", 409);
  }
}

export function createTaskExecutionDatabase(pool: TenantPool): TaskExecutionDatabase {
  return {
    async getLatest(session, taskId) {
      assertUuid(taskId, "taskId");
      return await withTenant(pool, session, async (database) => {
        const result = await database.query<ExecutionRow>(
          `SELECT ${executionColumns} FROM task_executions WHERE organization_id=$1 AND task_id=$2 ORDER BY attempt DESC LIMIT 1`,
          [session.organizationId, taskId],
        );
        return result.rows[0] ? execution(result.rows[0]) : null;
      });
    },

    async start(session, taskId, options) {
      assertUuid(taskId, "taskId");
      if (!Number.isFinite(options.budgetUsd) || options.budgetUsd <= 0) throw new Error("execution budget must be greater than zero");
      if (!Number.isSafeInteger(options.timeoutSeconds) || options.timeoutSeconds <= 0) throw new Error("execution timeout must be a positive integer");

      return await withTenant(pool, session, async (database) => {
        const task = await taskControl(database, session, taskId);
        validateStart(task, session);

        const active = await database.query<ExecutionRow>(
          `SELECT ${executionColumns} FROM task_executions WHERE organization_id=$1 AND task_id=$2 AND status IN ('queued','running') ORDER BY attempt DESC LIMIT 1`,
          [session.organizationId, taskId],
        );
        if (active.rows[0]) return { execution: execution(active.rows[0]), created: false };

        const inserted = await database.query<ExecutionRow>(
          `INSERT INTO task_executions (
             id,organization_id,task_id,project_id,attempt,started_by_user_id,
             source_commit_sha,source_version_id,budget_usd,timeout_seconds
           )
           SELECT gen_random_uuid(),$1,$2,$3,COALESCE(MAX(e.attempt),0)+1,$4,$5,$6,$7,$8
             FROM task_executions e
            WHERE e.organization_id=$1 AND e.task_id=$2
           ON CONFLICT DO NOTHING
           RETURNING ${executionColumns}`,
          [session.organizationId, taskId, task.project_id, session.userId, task.planned_source_commit_sha, task.planned_source_version_id, options.budgetUsd, options.timeoutSeconds],
        );
        if (inserted.rows[0]) {
          await database.query(
            `INSERT INTO audit_events (id,organization_id,actor_user_id,task_id,event_type,payload)
             VALUES (gen_random_uuid(),$1,$2,$3,'task_execution_started',jsonb_build_object('execution_id',$4::text))`,
            [session.organizationId, session.userId, taskId, inserted.rows[0].id],
          );
          return { execution: execution(inserted.rows[0]), created: true };
        }

        const raced = await database.query<ExecutionRow>(
          `SELECT ${executionColumns} FROM task_executions WHERE organization_id=$1 AND task_id=$2 AND status IN ('queued','running') ORDER BY attempt DESC LIMIT 1`,
          [session.organizationId, taskId],
        );
        if (!raced.rows[0]) throw new Error("task execution start lost its active row");
        return { execution: execution(raced.rows[0]), created: false };
      });
    },

    async cancel(session, taskId) {
      assertUuid(taskId, "taskId");
      return await withTenant(pool, session, async (database) => {
        const task = await taskControl(database, session, taskId);
        if (!canControl(task, session)) throw new AppError("TASK_EXECUTION_FORBIDDEN", "You cannot cancel implementation for this task.", 403);

        const active = await database.query<ExecutionRow>(
          `SELECT ${executionColumns} FROM task_executions WHERE organization_id=$1 AND task_id=$2 AND status IN ('queued','running') ORDER BY attempt DESC LIMIT 1 FOR UPDATE`,
          [session.organizationId, taskId],
        );
        const current = active.rows[0];
        if (!current) throw new AppError("TASK_EXECUTION_NOT_ACTIVE", "There is no active implementation to cancel.", 409);

        const updated = current.status === "queued"
          ? await database.query<ExecutionRow>(
              `UPDATE task_executions SET status='cancelled',cancel_requested_at=now(),cancelled_by_user_id=$3,finished_at=now(),updated_at=now()
                WHERE organization_id=$1 AND id=$2 RETURNING ${executionColumns}`,
              [session.organizationId, current.id, session.userId],
            )
          : await database.query<ExecutionRow>(
              `UPDATE task_executions SET cancel_requested_at=COALESCE(cancel_requested_at,now()),cancelled_by_user_id=COALESCE(cancelled_by_user_id,$3),updated_at=now()
                WHERE organization_id=$1 AND id=$2 RETURNING ${executionColumns}`,
              [session.organizationId, current.id, session.userId],
            );

        const row = updated.rows[0];
        if (!row) throw new Error("task execution cancel returned no row");
        await database.query(
          `INSERT INTO audit_events (id,organization_id,actor_user_id,task_id,event_type,payload)
           VALUES (gen_random_uuid(),$1,$2,$3,'task_execution_cancelled',jsonb_build_object('execution_id',$4::text))`,
          [session.organizationId, session.userId, taskId, row.id],
        );
        return execution(row);
      });
    },
  };
}

// PostgreSQL enforces this partial unique index; keeping the name here makes the concurrency invariant reviewable.
export const ACTIVE_EXECUTION_INDEX = "task_executions_one_active_per_task";

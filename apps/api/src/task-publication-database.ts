import type { SessionIdentity } from "./auth.js";
import { assertUuid, type TenantPool, withTenant } from "./database.js";
import { AppError } from "./errors.js";
import type { PublicationResult } from "./github-publication.js";
import type { TaskPublicationDatabase, TaskPublishContext } from "./task-publication-service.js";

export type TaskPublicationRecord = {
  readonly executionId: string;
  readonly status: "publishing" | "published" | "failed" | "source_changed";
  readonly branchName: string;
  readonly baseMovedCommits: number | null;
  readonly pullRequestNumber: number | null;
  readonly pullRequestUrl: string | null;
  readonly unproven: boolean;
  readonly failureCode: string | null;
  readonly failureMessage: string | null;
};

type PublishedResult = Extract<PublicationResult, { status: "published" }>;
type SourceChangedResult = Extract<PublicationResult, { status: "source_changed" }>;
type PublishContextRow = {
  execution_id: string;
  execution_status: string;
  current_user_role: "owner" | "developer" | "rep";
  repository_full_name: string | null;
  default_branch: string | null;
  approved_sha: string | null;
  approved_plan: string | null;
  result_patch: string | null;
  change_document: string | null;
};
type PublicationRow = {
  execution_id: string;
  status: TaskPublicationRecord["status"];
  branch_name: string;
  base_moved_commits: number | null;
  pull_request_number: number | null;
  pull_request_url: string | null;
  unproven: boolean;
  failure_code: string | null;
  failure_message: string | null;
};
function mapPublication(row: PublicationRow): TaskPublicationRecord {
  return { executionId: row.execution_id, status: row.status, branchName: row.branch_name, baseMovedCommits: row.base_moved_commits, pullRequestNumber: row.pull_request_number, pullRequestUrl: row.pull_request_url, unproven: row.unproven, failureCode: row.failure_code, failureMessage: row.failure_message };
}

export function createTaskPublicationDatabase(pool: TenantPool): TaskPublicationDatabase {
  const getRow = async (session: SessionIdentity, taskId: string): Promise<TaskPublicationRecord | null> => await withTenant(pool, session, async (database) => {
    const result = await database.query<PublicationRow>(
      `SELECT p.execution_id,p.status,p.branch_name,p.base_moved_commits,p.pull_request_number,p.pull_request_url,p.unproven,p.failure_code,p.failure_message
         FROM task_execution_publications p
         JOIN task_executions e ON e.organization_id=p.organization_id AND e.id=p.execution_id
        WHERE p.organization_id=$1 AND e.task_id=$2
        ORDER BY p.updated_at DESC LIMIT 1`,
      [session.organizationId, taskId],
    );
    return result.rows[0] ? mapPublication(result.rows[0]) : null;
  });

  return {
    async getPublishContext(session, taskId) {
      assertUuid(taskId, "taskId");
      return await withTenant(pool, session, async (database) => {
        const result = await database.query<PublishContextRow>(
          `SELECT e.id AS execution_id,e.status AS execution_status,m.role AS current_user_role,
                  r.full_name AS repository_full_name,r.default_branch,
                  e.source_commit_sha AS approved_sha,t.confirmed_plan AS approved_plan,
                  e.result_patch,e.change_document
             FROM task_executions e
             JOIN tasks t ON t.organization_id=e.organization_id AND t.id=e.task_id
             JOIN organization_memberships m ON m.organization_id=e.organization_id AND m.user_id=$3
             LEFT JOIN repositories r ON r.organization_id=e.organization_id AND r.id=t.repository_id AND r.provider='github'
            WHERE e.organization_id=$1 AND e.task_id=$2
            ORDER BY e.attempt DESC LIMIT 1`,
          [session.organizationId, taskId, session.userId],
        );
        const row = result.rows[0];
        if (!row) return null;
        if (!row.repository_full_name || !row.default_branch || !row.approved_sha) throw new AppError("TASK_PUBLICATION_NOT_ALLOWED", "Only GitHub implementation results can be published in this step.", 409);
        if (!row.approved_plan || !row.result_patch || !row.change_document) throw new AppError("TASK_PUBLICATION_NOT_ALLOWED", "This implementation result is missing publication evidence.", 409);
        return { executionId: row.execution_id, executionStatus: row.execution_status, currentUserRole: row.current_user_role, repositoryFullName: row.repository_full_name, defaultBranch: row.default_branch, approvedSha: row.approved_sha, approvedPlan: row.approved_plan, patch: row.result_patch, changeDocument: row.change_document } satisfies TaskPublishContext;
      });
    },
    async markPublishing(session, taskId, input) {
      assertUuid(taskId, "taskId"); assertUuid(input.executionId, "executionId");
      await withTenant(pool, session, async (database) => {
        const current = await database.query<{ source_commit_sha: string | null }>("SELECT source_commit_sha FROM task_executions WHERE organization_id=$1 AND task_id=$2 AND id=$3 LIMIT 1", [session.organizationId, taskId, input.executionId]);
        const approvedSha = current.rows[0]?.source_commit_sha;
        if (!approvedSha) throw new AppError("TASK_PUBLICATION_NOT_ALLOWED", "Only GitHub implementation results can be published in this step.", 409);
        await database.query(
          `INSERT INTO task_execution_publications (organization_id,task_id,execution_id,requested_by_user_id,status,branch_name,approved_sha,unproven)
           VALUES ($1,$2,$3,$4,'publishing',$5,$6,$7)
           ON CONFLICT (organization_id,execution_id) DO UPDATE
             SET status=CASE WHEN task_execution_publications.status='published' THEN 'published' ELSE 'publishing' END,
                 requested_by_user_id=EXCLUDED.requested_by_user_id,failure_code=NULL,failure_message=NULL,updated_at=now()`,
          [session.organizationId, taskId, input.executionId, session.userId, input.branchName, approvedSha, input.unproven],
        );
      });
    },
    async markPublished(session, taskId, result: PublishedResult) {
      await withTenant(pool, session, async (database) => {
        await database.query(
          `UPDATE task_execution_publications p SET status='published',current_head_sha=$3,branch_head_sha=$4,base_moved_commits=$5,pull_request_number=$6,pull_request_url=$7,failure_code=NULL,failure_message=NULL,published_at=COALESCE(published_at,now()),updated_at=now()
            FROM task_executions e WHERE p.organization_id=$1 AND e.organization_id=p.organization_id AND e.id=p.execution_id AND e.task_id=$2`,
          [session.organizationId, taskId, result.currentHeadSha, result.branchHeadSha, result.baseMovedCommits, result.pullRequestNumber, result.pullRequestUrl],
        );
      });
      return await getRow(session, taskId);
    },
    async markSourceChanged(session, taskId, result: SourceChangedResult) {
      await withTenant(pool, session, async (database) => {
        await database.query(
          `UPDATE task_execution_publications p SET status='source_changed',current_head_sha=$3,base_moved_commits=$4,failure_code='SOURCE_CHANGED',failure_message='A file named in the approved plan or implementation patch changed after approval. Re-plan before publishing.',updated_at=now()
            FROM task_executions e WHERE p.organization_id=$1 AND e.organization_id=p.organization_id AND e.id=p.execution_id AND e.task_id=$2`,
          [session.organizationId, taskId, result.currentHeadSha, result.baseMovedCommits],
        );
      });
      return await getRow(session, taskId);
    },
    async markFailed(session, taskId, failure) {
      await withTenant(pool, session, async (database) => { await database.query("UPDATE task_execution_publications SET status='failed',failure_code=$4,failure_message=$5,updated_at=now() WHERE organization_id=$1 AND task_id=$2 AND execution_id=$3", [session.organizationId, taskId, failure.executionId, failure.code, failure.message]); });
      return await getRow(session, taskId);
    },
    async getLatest(session, taskId) { assertUuid(taskId, "taskId"); return await getRow(session, taskId); },
  };
}

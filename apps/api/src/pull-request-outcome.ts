import type { TenantQuery } from "./database.js";
import { recordProjectDecision } from "./project-decision-database.js";

export type PullRequestState = "open" | "merged" | "closed";

// GitHub's pull request JSON (REST or webhook payload) to Dhara's three states.
export function pullRequestStateFromGitHub(pullRequest: { readonly state?: unknown; readonly merged?: unknown; readonly merged_at?: unknown }): PullRequestState {
  if (pullRequest.merged === true || (typeof pullRequest.merged_at === "string" && pullRequest.merged_at.length > 0)) return "merged";
  return pullRequest.state === "closed" ? "closed" : "open";
}

// Records what happened to a published pull request, inside one tenant
// transaction. "open" only stamps the check time. "merged" or "closed" is final:
// it is written once, and it replaces the "Published pull request #N" project
// memory entry (same memory key) with the real outcome.
export async function recordPullRequestOutcome(
  database: { readonly query: TenantQuery },
  organizationId: string,
  input: { readonly publicationId: string; readonly state: PullRequestState },
): Promise<"recorded" | "unchanged"> {
  if (input.state === "open") {
    await database.query(
      `UPDATE task_execution_publications SET pull_request_state='open',pull_request_checked_at=now(),updated_at=now()
        WHERE organization_id=$1 AND id=$2 AND status='published' AND (pull_request_state IS NULL OR pull_request_state='open')`,
      [organizationId, input.publicationId],
    );
    return "unchanged";
  }
  const updated = await database.query<{ execution_id: string; task_id: string; project_id: string; pull_request_number: number }>(
    `UPDATE task_execution_publications AS p
        SET pull_request_state=$3,pull_request_resolved_at=now(),pull_request_checked_at=now(),updated_at=now()
       FROM tasks AS t
      WHERE p.organization_id=$1 AND p.id=$2 AND p.status='published' AND (p.pull_request_state IS NULL OR p.pull_request_state='open')
        AND t.organization_id=p.organization_id AND t.id=p.task_id
      RETURNING p.execution_id,p.task_id,t.project_id,p.pull_request_number`,
    [organizationId, input.publicationId, input.state],
  );
  const row = updated.rows[0];
  if (!row) return "unchanged";
  const merged = input.state === "merged";
  await recordProjectDecision(database, organizationId, {
    projectId: row.project_id,
    taskId: row.task_id,
    kind: merged ? "reviewer_accepted" : "reviewer_rejected",
    summary: merged ? `Pull request #${row.pull_request_number} was merged.` : `Pull request #${row.pull_request_number} was closed without merging.`,
    detail: { executionId: row.execution_id, pullRequestNumber: row.pull_request_number, outcome: input.state },
    source: "publication",
    memoryKey: `publication:${row.execution_id}`,
  });
  return "recorded";
}

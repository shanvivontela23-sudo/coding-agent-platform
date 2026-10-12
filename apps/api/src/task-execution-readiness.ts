import type { SessionIdentity } from "./auth.js";
import { assertUuid, type TenantPool, withTenant } from "./database.js";
import { AppError } from "./errors.js";

export type TaskExecutionStartReadiness = {
  readonly reportHasInstallCommand: boolean;
  readonly githubInstallationId: number | null;
};

export interface TaskExecutionReadinessReader {
  get(session: SessionIdentity, taskId: string): Promise<TaskExecutionStartReadiness>;
}

export function createTaskExecutionReadinessReader(pool: TenantPool): TaskExecutionReadinessReader {
  return {
    async get(session, taskId) {
      assertUuid(taskId, "taskId");
      return await withTenant(pool, session, async (database) => {
        const result = await database.query<{
          report_has_install_command: boolean;
          planned_source_commit_sha: string | null;
          installation_id: string | number | null;
        }>(
          `SELECT (pr.report ? 'installCommand') AS report_has_install_command,
                  t.planned_source_commit_sha,
                  CASE WHEN t.planned_source_commit_sha IS NOT NULL THEN gi.installation_id ELSE NULL END AS installation_id
             FROM tasks t
             JOIN project_reports pr
               ON pr.organization_id=t.organization_id AND pr.project_id=t.project_id
             LEFT JOIN github_installations gi
               ON gi.organization_id=t.organization_id AND gi.status='connected'
            WHERE t.organization_id=$1 AND t.id=$2
            LIMIT 1`,
          [session.organizationId, taskId],
        );
        const row = result.rows[0];
        if (!row) throw new AppError("TASK_EXECUTION_NOT_FOUND", "Task not found.", 404);
        const installationId = row.installation_id === null ? null : Number(row.installation_id);
        if (installationId !== null && (!Number.isSafeInteger(installationId) || installationId <= 0)) {
          throw new AppError("GITHUB_INSTALLATION_DISCONNECTED", "GitHub installation is disconnected.", 409);
        }
        if (row.planned_source_commit_sha !== null && installationId === null) {
          throw new AppError("GITHUB_INSTALLATION_DISCONNECTED", "GitHub installation is disconnected.", 409);
        }
        return { reportHasInstallCommand: row.report_has_install_command, githubInstallationId: installationId };
      });
    },
  };
}

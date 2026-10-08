import type { SessionIdentity } from "./auth.js";
import { assertUuid, type TenantPool, withTenant } from "./database.js";
import type { QuestionFilterStats, TaskEstimate } from "./task-intake.js";

export interface TaskReviewMetricsStore {
  saveClarificationStats(session: SessionIdentity, taskId: string, stats: QuestionFilterStats): Promise<void>;
  saveEstimateRange(session: SessionIdentity, taskId: string, estimate: TaskEstimate): Promise<void>;
}

export function createTaskReviewMetricsStore(pool: TenantPool): TaskReviewMetricsStore {
  return {
    async saveClarificationStats(session, taskId, stats) {
      assertUuid(taskId, "taskId");
      await withTenant(pool, session, async (database) => {
        await database.query(`UPDATE tasks SET clarification_filtered_count=$3,clarification_rephrased_count=$4,updated_at=now() WHERE organization_id=$1 AND id=$2`, [session.organizationId, taskId, stats.filteredCount, stats.rephrasedCount]);
      });
    },
    async saveEstimateRange(session, taskId, estimate) {
      assertUuid(taskId, "taskId");
      await withTenant(pool, session, async (database) => {
        await database.query(`UPDATE tasks SET estimated_cost_usd_min=$3,estimated_cost_usd_max=$4,estimated_time_minutes_min=$5,estimated_time_minutes_max=$6,updated_at=now() WHERE organization_id=$1 AND id=$2`, [session.organizationId, taskId, estimate.costUsdMin, estimate.costUsdMax, estimate.timeMinutesMin, estimate.timeMinutesMax]);
      });
    },
  };
}

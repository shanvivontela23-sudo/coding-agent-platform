import type { SessionIdentity } from "./auth.js";
import { assertUuid, type MemberRole, type TenantPool, withTenant } from "./database.js";
import type { CostRecord } from "../../../evals/src/gateway/types.js";
import type { QuestionFilterStats, TaskPlan, TaskQuestion } from "./task-intake.js";

export type TaskStatus = "draft" | "waiting_for_answers" | "plan_ready" | "approved";
export type TaskQuestionRecord = TaskQuestion & {
  readonly id: string;
  readonly ordinal: number;
  readonly answer: string | null;
  readonly answerStatus: "unanswered" | "answered" | "developer_needed";
  readonly routedToUserId: string | null;
};
export type TaskListItem = {
  readonly id: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly status: TaskStatus;
  readonly requestedByUserId: string;
  readonly maskedTicket: string;
  readonly updatedAt: string;
};
export type TaskDetail = TaskListItem & {
  readonly repositoryId: string | null;
  readonly jobType: string | null;
  readonly whatIUnderstand: string | null;
  readonly proposedApproach: string | null;
  readonly jobSize: TaskPlan["size"] | null;
  readonly estimatedCostUsd: number | null;
  readonly estimatedTimeMinutes: number | null;
  readonly estimatedCostUsdMin: number | null;
  readonly estimatedCostUsdMax: number | null;
  readonly estimatedTimeMinutesMin: number | null;
  readonly estimatedTimeMinutesMax: number | null;
  readonly clarificationFilteredCount: number;
  readonly clarificationRephrasedCount: number;
  readonly confirmedRequirement: string | null;
  readonly confirmedPlan: string | null;
  readonly modelBudgetUsd: number;
  readonly originalTicketEncrypted: string | null;
  readonly questions: readonly TaskQuestionRecord[];
  readonly currentUserRole: MemberRole;
};
export type TaskProjectSource = {
  readonly projectId: string;
  readonly repositoryId: string;
  readonly githubRepositoryId: number;
  readonly installationId: number;
  readonly installationStatus: "connected" | "disconnected";
};

export interface TaskDatabase {
  createTask(session: SessionIdentity, input: { projectId: string; encryptedTicket: string; maskedTicket: string; modelBudgetUsd: number }): Promise<{ taskId: string }>;
  listTasks(session: SessionIdentity): Promise<readonly TaskListItem[]>;
  getTask(session: SessionIdentity, taskId: string): Promise<TaskDetail | null>;
  getProjectSource(session: SessionIdentity, projectId: string): Promise<TaskProjectSource | null>;
  saveClarification(session: SessionIdentity, taskId: string, jobType: string, questions: readonly TaskQuestion[], stats?: QuestionFilterStats): Promise<void>;
  answerQuestion(session: SessionIdentity, taskId: string, questionId: string, answer: string, developerNeeded: boolean): Promise<void>;
  unresolvedQuestionCount(session: SessionIdentity, taskId: string): Promise<number>;
  savePlan(session: SessionIdentity, taskId: string, plan: TaskPlan): Promise<void>;
  approveTask(session: SessionIdentity, taskId: string, input: { whatIUnderstand: string; proposedApproach: string }): Promise<void>;
  recordModelCall(session: SessionIdentity, taskId: string, cost: CostRecord): Promise<void>;
}

function iso(value: Date | string): string { return value instanceof Date ? value.toISOString() : value; }
function number(value: string | number | null): number | null { return value === null ? null : Number(value); }

export function createTaskDatabase(pool: TenantPool): TaskDatabase {
  return {
    async createTask(session, input) {
      assertUuid(input.projectId, "projectId");
      if (!input.encryptedTicket || !input.maskedTicket.trim()) throw new Error("task ticket is required");
      if (!Number.isFinite(input.modelBudgetUsd) || input.modelBudgetUsd <= 0) throw new Error("task model budget must be greater than zero");
      return await withTenant(pool, session, async (database) => {
        const source = await database.query<{ repository_id: string }>(`SELECT r.id AS repository_id FROM projects p JOIN repositories r ON r.organization_id=p.organization_id AND r.project_id=p.id WHERE p.organization_id=$1 AND p.id=$2 LIMIT 1`, [session.organizationId, input.projectId]);
        const repositoryId = source.rows[0]?.repository_id;
        if (!repositoryId) throw new Error("project repository is not visible");
        const created = await database.query<{ id: string }>(`INSERT INTO tasks (id,organization_id,project_id,repository_id,requested_by_user_id,status,requirement,original_ticket_encrypted,masked_ticket,task_model_budget_usd) VALUES (gen_random_uuid(),$1,$2,$3,$4,'draft',$5,$6,$5,$7) RETURNING id`, [session.organizationId, input.projectId, repositoryId, session.userId, input.maskedTicket, input.encryptedTicket, input.modelBudgetUsd]);
        const taskId = created.rows[0]?.id;
        if (!taskId) throw new Error("task creation returned no id");
        await database.query(`INSERT INTO audit_events (id,organization_id,actor_user_id,task_id,event_type,payload) VALUES (gen_random_uuid(),$1,$2,$3,'task_created','{}'::jsonb)`, [session.organizationId, session.userId, taskId]);
        return { taskId };
      });
    },

    async listTasks(session) {
      return await withTenant(pool, session, async (database) => {
        const result = await database.query<{ id: string; project_id: string; project_name: string; status: TaskStatus; requested_by_user_id: string; masked_ticket: string | null; requirement: string; updated_at: Date | string }>(`SELECT t.id,t.project_id,p.name AS project_name,t.status,t.requested_by_user_id,t.masked_ticket,t.requirement,t.updated_at FROM tasks t JOIN projects p ON p.organization_id=t.organization_id AND p.id=t.project_id WHERE t.organization_id=$1 ORDER BY t.updated_at DESC,t.id`, [session.organizationId]);
        return result.rows.map((row) => ({ id: row.id, projectId: row.project_id, projectName: row.project_name, status: row.status, requestedByUserId: row.requested_by_user_id, maskedTicket: row.masked_ticket ?? row.requirement, updatedAt: iso(row.updated_at) }));
      });
    },

    async getTask(session, taskId) {
      assertUuid(taskId, "taskId");
      return await withTenant(pool, session, async (database) => {
        const result = await database.query<{
          id: string; project_id: string; project_name: string; repository_id: string | null; status: TaskStatus; requested_by_user_id: string; masked_ticket: string | null; requirement: string; original_ticket_encrypted: string | null; job_type: string | null; what_i_understand: string | null; proposed_approach: string | null; job_size: TaskPlan["size"] | null; estimated_cost_usd: string | number | null; estimated_time_minutes: number | null; estimated_cost_usd_min: string | number | null; estimated_cost_usd_max: string | number | null; estimated_time_minutes_min: number | null; estimated_time_minutes_max: number | null; clarification_filtered_count: number; clarification_rephrased_count: number; confirmed_requirement: string | null; confirmed_plan: string | null; task_model_budget_usd: string | number; updated_at: Date | string; current_user_role: MemberRole;
        }>(`SELECT t.id,t.project_id,p.name AS project_name,t.repository_id,t.status,t.requested_by_user_id,t.masked_ticket,t.requirement,t.original_ticket_encrypted,t.job_type,t.what_i_understand,t.proposed_approach,t.job_size,t.estimated_cost_usd,t.estimated_time_minutes,t.estimated_cost_usd_min,t.estimated_cost_usd_max,t.estimated_time_minutes_min,t.estimated_time_minutes_max,t.clarification_filtered_count,t.clarification_rephrased_count,t.confirmed_requirement,t.confirmed_plan,t.task_model_budget_usd,t.updated_at,m.role AS current_user_role FROM tasks t JOIN projects p ON p.organization_id=t.organization_id AND p.id=t.project_id JOIN organization_memberships m ON m.organization_id=t.organization_id AND m.user_id=$3 WHERE t.organization_id=$1 AND t.id=$2 LIMIT 1`, [session.organizationId, taskId, session.userId]);
        const row = result.rows[0];
        if (!row) return null;
        const questions = await database.query<{ id: string; ordinal: number; question: string; suggested_answer: string; answer: string | null; answer_status: TaskQuestionRecord["answerStatus"]; routed_to_user_id: string | null }>(`SELECT id,ordinal,question,suggested_answer,answer,answer_status,routed_to_user_id FROM task_questions WHERE organization_id=$1 AND task_id=$2 ORDER BY ordinal`, [session.organizationId, taskId]);
        return {
          id: row.id, projectId: row.project_id, projectName: row.project_name, repositoryId: row.repository_id, status: row.status,
          requestedByUserId: row.requested_by_user_id, maskedTicket: row.masked_ticket ?? row.requirement, updatedAt: iso(row.updated_at),
          jobType: row.job_type, whatIUnderstand: row.what_i_understand, proposedApproach: row.proposed_approach, jobSize: row.job_size,
          estimatedCostUsd: number(row.estimated_cost_usd), estimatedTimeMinutes: row.estimated_time_minutes,
          estimatedCostUsdMin: number(row.estimated_cost_usd_min), estimatedCostUsdMax: number(row.estimated_cost_usd_max), estimatedTimeMinutesMin: row.estimated_time_minutes_min, estimatedTimeMinutesMax: row.estimated_time_minutes_max,
          clarificationFilteredCount: row.clarification_filtered_count, clarificationRephrasedCount: row.clarification_rephrased_count,
          confirmedRequirement: row.confirmed_requirement, confirmedPlan: row.confirmed_plan, modelBudgetUsd: Number(row.task_model_budget_usd), originalTicketEncrypted: row.original_ticket_encrypted,
          currentUserRole: row.current_user_role,
          questions: questions.rows.map((question) => ({ id: question.id, ordinal: question.ordinal, question: question.question, suggestedAnswer: question.suggested_answer, answer: question.answer, answerStatus: question.answer_status, routedToUserId: question.routed_to_user_id })),
        };
      });
    },

    async getProjectSource(session, projectId) {
      assertUuid(projectId, "projectId");
      return await withTenant(pool, session, async (database) => {
        const result = await database.query<{ project_id: string; repository_id: string; github_repository_id: string | number; installation_id: string | number; installation_status: "connected" | "disconnected" }>(`SELECT p.id AS project_id,r.id AS repository_id,r.github_repository_id,gi.installation_id,gi.status AS installation_status FROM projects p JOIN repositories r ON r.organization_id=p.organization_id AND r.project_id=p.id JOIN github_installations gi ON gi.organization_id=p.organization_id WHERE p.organization_id=$1 AND p.id=$2 AND r.github_repository_id IS NOT NULL LIMIT 1`, [session.organizationId, projectId]);
        const row = result.rows[0];
        return row ? { projectId: row.project_id, repositoryId: row.repository_id, githubRepositoryId: Number(row.github_repository_id), installationId: Number(row.installation_id), installationStatus: row.installation_status } : null;
      });
    },

    async saveClarification(session, taskId, jobType, questions, stats = { filteredCount: 0, rephrasedCount: 0 }) {
      assertUuid(taskId, "taskId");
      if (questions.length > 5) throw new Error("too many clarification questions");
      await withTenant(pool, session, async (database) => {
        await database.query("DELETE FROM task_questions WHERE organization_id=$1 AND task_id=$2", [session.organizationId, taskId]);
        for (const [index, question] of questions.entries()) await database.query(`INSERT INTO task_questions (id,organization_id,task_id,ordinal,question,suggested_answer) VALUES (gen_random_uuid(),$1,$2,$3,$4,$5)`, [session.organizationId, taskId, index + 1, question.question, question.suggestedAnswer]);
        const status: TaskStatus = questions.length > 0 ? "waiting_for_answers" : "plan_ready";
        await database.query("UPDATE tasks SET job_type=$3,status=$4,clarification_filtered_count=$5,clarification_rephrased_count=$6,updated_at=now() WHERE organization_id=$1 AND id=$2", [session.organizationId, taskId, jobType, status, stats.filteredCount, stats.rephrasedCount]);
      });
    },

    async answerQuestion(session, taskId, questionId, answer, developerNeeded) {
      assertUuid(taskId, "taskId"); assertUuid(questionId, "questionId");
      await withTenant(pool, session, async (database) => {
        const task = await database.query<{ requested_by_user_id: string }>("SELECT requested_by_user_id FROM tasks WHERE organization_id=$1 AND id=$2 LIMIT 1", [session.organizationId, taskId]);
        const requestedBy = task.rows[0]?.requested_by_user_id;
        if (!requestedBy) throw new Error("task not found");
        const current = await database.query<{ role: MemberRole }>("SELECT role FROM organization_memberships WHERE organization_id=$1 AND user_id=$2 LIMIT 1", [session.organizationId, session.userId]);
        const role = current.rows[0]?.role;
        if (!role) throw new Error("membership not found");
        const question = await database.query<{ routed_to_user_id: string | null }>("SELECT routed_to_user_id FROM task_questions WHERE organization_id=$1 AND task_id=$2 AND id=$3 LIMIT 1", [session.organizationId, taskId, questionId]);
        const row = question.rows[0];
        if (!row) throw new Error("question not found");
        if (session.userId !== requestedBy && row.routed_to_user_id !== session.userId && role !== "owner") throw new Error("question is not assigned to this user");
        if (developerNeeded) {
          if (session.userId !== requestedBy) throw new Error("only the requester can route a question to a developer");
          const developer = await database.query<{ user_id: string }>("SELECT user_id FROM organization_memberships WHERE organization_id=$1 AND role='developer' ORDER BY created_at,user_id LIMIT 1", [session.organizationId]);
          const developerId = developer.rows[0]?.user_id;
          if (!developerId) throw new Error("no developer is available for this question");
          await database.query("UPDATE task_questions SET answer=$4,answer_status='developer_needed',routed_to_user_id=$5,answered_at=now() WHERE organization_id=$1 AND task_id=$2 AND id=$3", [session.organizationId, taskId, questionId, "I don't know", developerId]);
        } else {
          if (!answer.trim()) throw new Error("answer is required");
          await database.query("UPDATE task_questions SET answer=$4,answer_status='answered',routed_to_user_id=NULL,answered_at=now() WHERE organization_id=$1 AND task_id=$2 AND id=$3", [session.organizationId, taskId, questionId, answer.trim()]);
        }
        await database.query("UPDATE tasks SET updated_at=now() WHERE organization_id=$1 AND id=$2", [session.organizationId, taskId]);
      });
    },

    async unresolvedQuestionCount(session, taskId) {
      assertUuid(taskId, "taskId");
      return await withTenant(pool, session, async (database) => {
        const result = await database.query<{ count: string | number }>("SELECT count(*) AS count FROM task_questions WHERE organization_id=$1 AND task_id=$2 AND answer_status <> 'answered'", [session.organizationId, taskId]);
        return Number(result.rows[0]?.count ?? 0);
      });
    },

    async savePlan(session, taskId, plan) {
      assertUuid(taskId, "taskId");
      const midpointCost = (plan.estimate.costUsdMin + plan.estimate.costUsdMax) / 2;
      const midpointMinutes = Math.round((plan.estimate.timeMinutesMin + plan.estimate.timeMinutesMax) / 2);
      await withTenant(pool, session, async (database) => {
        await database.query(`UPDATE tasks SET what_i_understand=$3,proposed_approach=$4,job_size=$5,estimated_cost_usd=$6,estimated_time_minutes=$7,estimated_cost_usd_min=$8,estimated_cost_usd_max=$9,estimated_time_minutes_min=$10,estimated_time_minutes_max=$11,status='plan_ready',updated_at=now() WHERE organization_id=$1 AND id=$2`, [session.organizationId, taskId, plan.whatIUnderstand, plan.proposedApproach, plan.size, midpointCost, midpointMinutes, plan.estimate.costUsdMin, plan.estimate.costUsdMax, plan.estimate.timeMinutesMin, plan.estimate.timeMinutesMax]);
      });
    },

    async approveTask(session, taskId, input) {
      assertUuid(taskId, "taskId");
      const requirement = input.whatIUnderstand.trim(); const plan = input.proposedApproach.trim();
      if (!requirement || !plan) throw new Error("confirmed requirement and plan are required");
      await withTenant(pool, session, async (database) => {
        const task = await database.query<{ requested_by_user_id: string }>("SELECT requested_by_user_id FROM tasks WHERE organization_id=$1 AND id=$2 AND status='plan_ready' LIMIT 1", [session.organizationId, taskId]);
        if (task.rows[0]?.requested_by_user_id !== session.userId) throw new Error("only the requesting representative can approve this plan");
        await database.query(`UPDATE tasks SET what_i_understand=$3,proposed_approach=$4,confirmed_requirement=$3,confirmed_plan=$4,status='approved',approved_at=now(),updated_at=now() WHERE organization_id=$1 AND id=$2`, [session.organizationId, taskId, requirement, plan]);
        await database.query(`INSERT INTO audit_events (id,organization_id,actor_user_id,task_id,event_type,payload) VALUES (gen_random_uuid(),$1,$2,$3,'task_plan_approved','{}'::jsonb)`, [session.organizationId, session.userId, taskId]);
      });
    },

    async recordModelCall(session, taskId, cost) {
      assertUuid(taskId, "taskId");
      await withTenant(pool, session, async (database) => {
        await database.query(`INSERT INTO model_calls (id,organization_id,task_id,provider,model,input_tokens,cached_input_tokens,output_tokens,reasoning_tokens,cost_usd) VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9)`, [session.organizationId, taskId, cost.provider, cost.model, cost.inputTokens, cost.cachedInputTokens, cost.outputTokens, cost.reasoningTokens, cost.listPriceCostUsd]);
      });
    },
  };
}

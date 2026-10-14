import type { SessionIdentity } from "./auth.js";
import { loadBuiltInStackSkillsSync } from "../../../packages/skills/src/registry.js";
import { stackPromptContext } from "../../../packages/skills/src/prompt.js";
import type { ProjectCodeReader } from "./project-code-reader.js";
import type { PlannedSourcePin, TaskDatabase, TaskDetail, TaskListItem } from "./task-database.js";
import { maskPersonalData, planningRunKey, TaskPlanner, type TaskModelGateway } from "./task-intake.js";
import type { TicketCipher } from "./ticket-crypto.js";

export type TaskView = Omit<TaskDetail, "originalTicketEncrypted"> & { readonly originalTicket?: string };

export interface TaskReadService {
  list(session: SessionIdentity): Promise<readonly TaskListItem[]>;
  get(session: SessionIdentity, taskId: string): Promise<TaskView | null>;
  approve(session: SessionIdentity, taskId: string, input: { whatIUnderstand: string; proposedApproach: string }): Promise<void>;
}

export interface TaskPlanningService {
  create(session: SessionIdentity, projectId: string, ticket: string): Promise<{ readonly taskId: string }>;
  answer(session: SessionIdentity, taskId: string, questionId: string, answer: string): Promise<void>;
  retryClarification(session: SessionIdentity, taskId: string): Promise<void>;
}

export interface TaskService extends TaskReadService, TaskPlanningService {}

export function createTaskReadService(options: {
  readonly database: TaskDatabase;
  readonly cipher: TicketCipher;
}): TaskReadService {
  return {
    async list(session) { return await options.database.listTasks(session); },

    async get(session, taskId) {
      const task = await options.database.getTask(session, taskId);
      if (!task) return null;
      const { originalTicketEncrypted, ...view } = task;
      if (originalTicketEncrypted && task.requestedByUserId === session.userId && task.currentUserRole === "rep") {
        return { ...view, originalTicket: options.cipher.decrypt(originalTicketEncrypted) };
      }
      return view;
    },

    async approve(session, taskId, input) { await options.database.approveTask(session, taskId, input); },
  };
}

// The task row exists even when clarification fails; carry its id so the
// HTTP layer can send the requester to the draft task to retry.
function withCreatedTaskId(error: unknown, taskId: string): unknown {
  if (typeof error === "object" && error !== null) {
    try { Object.defineProperty(error, "taskId", { value: taskId, enumerable: false, configurable: true }); } catch { /* frozen error */ }
  }
  return error;
}

export function createTaskPlanningService(options: {
  readonly database: TaskDatabase;
  readonly codeReader: ProjectCodeReader;
  readonly gateway: TaskModelGateway;
  readonly cipher: TicketCipher;
  readonly modelBudgetUsd: number;
}): TaskPlanningService {
  if (!Number.isFinite(options.modelBudgetUsd) || options.modelBudgetUsd <= 0) throw new Error("task model budget must be greater than zero");
  const planner = new TaskPlanner({ gateway: options.gateway, spendCapUsd: options.modelBudgetUsd });
  const skills = loadBuiltInStackSkillsSync();

  // Gateway costs are collected per planning run key; they are recorded
  // against the real task id.
  const persistCosts = async (session: SessionIdentity, taskId: string, runKey = taskId) => {
    for (const cost of options.gateway.takeCostRecords?.(runKey) ?? []) await options.database.recordModelCall(session, taskId, cost);
  };

  const makePlanIfReady = async (session: SessionIdentity, taskId: string): Promise<void> => {
    if (await options.database.unresolvedQuestionCount(session, taskId) !== 0) return;
    const task = await options.database.getTask(session, taskId);
    if (!task || task.status === "approved") return;
    const context = await options.codeReader.readContext(session, task.projectId, task.maskedTicket);
    const stack = stackPromptContext(context.report, skills);
    const sourcePin: PlannedSourcePin = context.source === "github"
      ? { source: "github", commitSha: context.revision }
      : { source: "upload", versionId: context.revision };
    const answers = task.questions.filter((question) => question.answerStatus === "answered" && question.answer).map((question) => ({ question: question.question, answer: question.answer! }));
    const runKey = planningRunKey(taskId, task.planningAttempt);
    try {
      const plan = await planner.plan({ taskId: runKey, maskedTicket: task.maskedTicket, repositoryContext: context.text, answers, trustedStackGuide: stack.trustedGuidePrefix });
      await persistCosts(session, taskId, runKey);
      await options.database.savePlan(session, taskId, plan, sourcePin);
    } catch (error) {
      await persistCosts(session, taskId, runKey);
      throw error;
    }
  };

  return {
    async create(session, projectId, ticketValue) {
      const ticket = ticketValue.trim();
      if (!ticket || ticket.length > 50_000) throw new Error("task ticket must be between 1 and 50000 characters");
      const maskedTicket = maskPersonalData(ticket);
      const created = await options.database.createTask(session, { projectId, encryptedTicket: options.cipher.encrypt(ticket), maskedTicket, modelBudgetUsd: options.modelBudgetUsd });
      const context = await options.codeReader.readContext(session, projectId, maskedTicket);
      const stack = stackPromptContext(context.report, skills);
      try {
        const clarification = await planner.clarify({ taskId: created.taskId, maskedTicket, repositoryContext: context.text, stackDisplayName: stack.clarificationLabel });
        await persistCosts(session, created.taskId);
        await options.database.saveClarification(session, created.taskId, clarification.jobType, clarification.questions, clarification.questionFilterStats);
        if (clarification.questions.length === 0) await makePlanIfReady(session, created.taskId);
      } catch (error) {
        await persistCosts(session, created.taskId);
        throw withCreatedTaskId(error, created.taskId);
      }
      return created;
    },

    async retryClarification(session, taskId) {
      const retry = await options.database.beginClarificationRetry(session, taskId);
      if (!retry) return;
      const runKey = planningRunKey(taskId, retry.planningAttempt);
      const context = await options.codeReader.readContext(session, retry.projectId, retry.maskedTicket);
      const stack = stackPromptContext(context.report, skills);
      try {
        const clarification = await planner.clarify({ taskId: runKey, maskedTicket: retry.maskedTicket, repositoryContext: context.text, stackDisplayName: stack.clarificationLabel });
        await persistCosts(session, taskId, runKey);
        await options.database.saveClarification(session, taskId, clarification.jobType, clarification.questions, clarification.questionFilterStats);
        if (clarification.questions.length === 0) await makePlanIfReady(session, taskId);
      } catch (error) {
        await persistCosts(session, taskId, runKey);
        throw error;
      }
    },

    async answer(session, taskId, questionId, answerValue) {
      const answer = answerValue.trim();
      const developerNeeded = /^i\s+don['’]?t\s+know$/i.test(answer);
      await options.database.answerQuestion(session, taskId, questionId, answer, developerNeeded);
      if (!developerNeeded) await makePlanIfReady(session, taskId);
    },
  };
}

export function createTaskService(options: {
  readonly database: TaskDatabase;
  readonly codeReader: ProjectCodeReader;
  readonly gateway: TaskModelGateway;
  readonly cipher: TicketCipher;
  readonly modelBudgetUsd: number;
}): TaskService {
  return {
    ...createTaskReadService({ database: options.database, cipher: options.cipher }),
    ...createTaskPlanningService(options),
  };
}

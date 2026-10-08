import type { SessionIdentity } from "./auth.js";
import type { ProjectCodeReader } from "./project-code-reader.js";
import type { TaskDatabase, TaskDetail, TaskListItem } from "./task-database.js";
import { maskPersonalData, TaskPlanner, type TaskModelGateway } from "./task-intake.js";
import type { TicketCipher } from "./ticket-crypto.js";

export type TaskView = Omit<TaskDetail, "originalTicketEncrypted"> & { readonly originalTicket?: string };

export interface TaskService {
  create(session: SessionIdentity, projectId: string, ticket: string): Promise<{ readonly taskId: string }>;
  list(session: SessionIdentity): Promise<readonly TaskListItem[]>;
  get(session: SessionIdentity, taskId: string): Promise<TaskView | null>;
  answer(session: SessionIdentity, taskId: string, questionId: string, answer: string): Promise<void>;
  approve(session: SessionIdentity, taskId: string, input: { whatIUnderstand: string; proposedApproach: string }): Promise<void>;
}

export function createTaskService(options: {
  readonly database: TaskDatabase;
  readonly codeReader: ProjectCodeReader;
  readonly gateway: TaskModelGateway;
  readonly cipher: TicketCipher;
  readonly modelBudgetUsd: number;
}): TaskService {
  if (!Number.isFinite(options.modelBudgetUsd) || options.modelBudgetUsd <= 0) throw new Error("task model budget must be greater than zero");
  const planner = new TaskPlanner({ gateway: options.gateway, spendCapUsd: options.modelBudgetUsd });

  const persistCosts = async (session: SessionIdentity, taskId: string) => {
    for (const cost of options.gateway.takeCostRecords?.(taskId) ?? []) await options.database.recordModelCall(session, taskId, cost);
  };

  const makePlanIfReady = async (session: SessionIdentity, taskId: string): Promise<void> => {
    if (await options.database.unresolvedQuestionCount(session, taskId) !== 0) return;
    const task = await options.database.getTask(session, taskId);
    if (!task || task.status === "approved") return;
    const context = await options.codeReader.readContext(session, task.projectId, task.maskedTicket);
    const answers = task.questions.filter((question) => question.answerStatus === "answered" && question.answer).map((question) => ({ question: question.question, answer: question.answer! }));
    try {
      const plan = await planner.plan({ taskId, maskedTicket: task.maskedTicket, repositoryContext: context.text, answers });
      await persistCosts(session, taskId);
      await options.database.savePlan(session, taskId, plan);
    } catch (error) {
      await persistCosts(session, taskId);
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
      try {
        const clarification = await planner.clarify({ taskId: created.taskId, maskedTicket, repositoryContext: context.text });
        await persistCosts(session, created.taskId);
        await options.database.saveClarification(session, created.taskId, clarification.jobType, clarification.questions);
        if (clarification.questions.length === 0) await makePlanIfReady(session, created.taskId);
      } catch (error) {
        await persistCosts(session, created.taskId);
        throw error;
      }
      return created;
    },

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

    async answer(session, taskId, questionId, answerValue) {
      const answer = answerValue.trim();
      const developerNeeded = /^i\s+don['’]?t\s+know$/i.test(answer);
      await options.database.answerQuestion(session, taskId, questionId, answer, developerNeeded);
      if (!developerNeeded) await makePlanIfReady(session, taskId);
    },

    async approve(session, taskId, input) { await options.database.approveTask(session, taskId, input); },
  };
}

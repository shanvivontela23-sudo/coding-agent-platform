import type { SessionIdentity } from "./auth.js";
import { AppError } from "./errors.js";
import type { ProjectDecision } from "../../../packages/db/src/project-decisions.js";
import type { MemberRole } from "./database.js";
import type { ProjectDecisionDatabase } from "./project-decision-database.js";

export interface ProjectDecisionService {
  list(session: SessionIdentity, projectId: string): Promise<{ readonly decisions: readonly ProjectDecision[]; readonly currentUserRole: MemberRole }>;
  supersede(session: SessionIdentity, projectId: string, decisionId: string): Promise<void>;
}
export function createProjectDecisionService(options: { readonly database: ProjectDecisionDatabase }): ProjectDecisionService {
  return {
    async list(session, projectId) {
      const [decisions, currentUserRole] = await Promise.all([options.database.listCurrent(session, projectId, 15), options.database.getMembershipRole(session)]);
      if (decisions === null) throw new AppError("PROJECT_DECISION_NOT_FOUND", "Project was not found.", 404);
      return { decisions, currentUserRole };
    },
    async supersede(session, projectId, decisionId) {
      if (await options.database.getMembershipRole(session) !== "owner") throw new AppError("PROJECT_DECISION_FORBIDDEN", "Only an organization owner can mark project knowledge as wrong.", 403);
      if (!await options.database.supersede(session, projectId, decisionId)) throw new AppError("PROJECT_DECISION_NOT_FOUND", "Project knowledge was not found.", 404);
    },
  };
}


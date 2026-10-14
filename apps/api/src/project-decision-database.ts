import type { SessionIdentity } from "./auth.js";
import { assertUuid, type MemberRole, type TenantPool, type TenantQuery, withTenant } from "./database.js";
import {
  projectDecisionKinds,
  projectDecisionSources,
  type ProjectDecision,
  type ProjectDecisionKind,
  type ProjectDecisionSource,
} from "../../../packages/db/src/project-decisions.js";

export type ProjectDecisionRecordInput = {
  readonly projectId: string;
  readonly taskId: string | null;
  readonly kind: ProjectDecisionKind;
  readonly summary: string;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly source: ProjectDecisionSource;
  readonly memoryKey: string;
};

export interface ProjectDecisionDatabase {
  listCurrent(session: SessionIdentity, projectId: string, limit?: number): Promise<readonly ProjectDecision[] | null>;
  record(session: Pick<SessionIdentity, "organizationId">, input: ProjectDecisionRecordInput): Promise<ProjectDecision>;
  supersede(session: SessionIdentity, projectId: string, decisionId: string): Promise<boolean>;
  getMembershipRole(session: SessionIdentity): Promise<MemberRole>;
}

type DecisionRow = {
  id: string;
  organization_id: string;
  project_id: string;
  task_id: string | null;
  kind: ProjectDecisionKind;
  summary: string;
  detail: Record<string, unknown>;
  source: ProjectDecisionSource;
  created_at: Date | string;
  superseded_by: string | null;
  same_detail?: boolean;
};

function iso(value: Date | string): string { return value instanceof Date ? value.toISOString() : value; }
function decision(row: DecisionRow): ProjectDecision {
  return { id: row.id, organizationId: row.organization_id, projectId: row.project_id, taskId: row.task_id, kind: row.kind, summary: row.summary, detail: row.detail, source: row.source, createdAt: iso(row.created_at), supersededBy: row.superseded_by };
}
function validEnum<T extends string>(value: string, values: readonly T[], label: string): asserts value is T {
  if (!(values as readonly string[]).includes(value)) throw new Error(`invalid project decision ${label}`);
}
function validateRecord(input: ProjectDecisionRecordInput): void {
  assertUuid(input.projectId, "projectId");
  if (input.taskId !== null) assertUuid(input.taskId, "taskId");
  validEnum(input.kind, projectDecisionKinds, "kind");
  validEnum(input.source, projectDecisionSources, "source");
  if (!input.summary.trim() || input.summary.length > 300) throw new Error("project decision summary must be 1 to 300 characters");
  if (!input.memoryKey.trim() || input.memoryKey.length > 200) throw new Error("project decision memory key must be 1 to 200 characters");
  if (JSON.stringify(input.detail).length > 12_000) throw new Error("project decision detail is too large");
}

export async function recordProjectDecision(
  database: { readonly query: TenantQuery },
  organizationId: string,
  input: ProjectDecisionRecordInput,
): Promise<ProjectDecision> {
  validateRecord(input);
  const detail = { ...input.detail, memoryKey: input.memoryKey };
  await database.query("SELECT pg_advisory_xact_lock(pg_catalog.hashtextextended($1,0))", [`project-decision:${organizationId}:${input.projectId}:${input.source}:${input.memoryKey}`]);
  const current = await database.query<DecisionRow>(
    `SELECT id,organization_id,project_id,task_id,kind,summary,detail,source,created_at,superseded_by,detail=$5::jsonb AS same_detail
       FROM project_decisions
      WHERE organization_id=$1 AND project_id=$2 AND source=$3 AND detail->>'memoryKey'=$4 AND superseded_by IS NULL
      LIMIT 1 FOR UPDATE`,
    [organizationId, input.projectId, input.source, input.memoryKey, JSON.stringify(detail)],
  );
  const previous = current.rows[0];
  if (previous && previous.kind === input.kind && previous.summary === input.summary && previous.same_detail === true) return decision(previous);
  if (previous) await database.query("UPDATE project_decisions SET superseded_by=id WHERE organization_id=$1 AND id=$2 AND superseded_by IS NULL", [organizationId, previous.id]);
  const inserted = await database.query<DecisionRow>(
    `INSERT INTO project_decisions (id,organization_id,project_id,task_id,kind,summary,detail,source)
     VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6::jsonb,$7)
     RETURNING id,organization_id,project_id,task_id,kind,summary,detail,source,created_at,superseded_by`,
    [organizationId, input.projectId, input.taskId, input.kind, input.summary, JSON.stringify(detail), input.source],
  );
  const row = inserted.rows[0];
  if (!row) throw new Error("project decision insertion returned no row");
  if (previous) await database.query("UPDATE project_decisions SET superseded_by=$3 WHERE organization_id=$1 AND id=$2", [organizationId, previous.id, row.id]);
  return decision(row);
}

export function createProjectDecisionDatabase(pool: TenantPool): ProjectDecisionDatabase {
  return {
    async listCurrent(session, projectId, limit = 15) {
      assertUuid(projectId, "projectId");
      if (!Number.isInteger(limit) || limit < 1 || limit > 15) throw new Error("project decision limit must be between 1 and 15");
      return await withTenant(pool, session, async (database) => {
        const project = await database.query<{ id: string }>("SELECT id FROM projects WHERE organization_id=$1 AND id=$2 LIMIT 1", [session.organizationId, projectId]);
        if (!project.rows[0]) return null;
        const result = await database.query<DecisionRow>(
          `SELECT id,organization_id,project_id,task_id,kind,summary,detail,source,created_at,superseded_by
             FROM project_decisions
            WHERE organization_id=$1 AND project_id=$2 AND superseded_by IS NULL
            ORDER BY created_at DESC,id DESC
            LIMIT $3`,
          [session.organizationId, projectId, limit],
        );
        return result.rows.map(decision);
      });
    },

    async record(session, input) {
      return await withTenant(pool, session, async (database) => await recordProjectDecision(database, session.organizationId, input));
    },

    async supersede(session, projectId, decisionId) {
      assertUuid(projectId, "projectId"); assertUuid(decisionId, "decisionId");
      return await withTenant(pool, session, async (database) => {
        const result = await database.query<{ id: string }>(
          `UPDATE project_decisions SET superseded_by=id
            WHERE organization_id=$1 AND project_id=$2 AND id=$3 AND (superseded_by IS NULL OR superseded_by=id)
            RETURNING id`,
          [session.organizationId, projectId, decisionId],
        );
        return result.rows.length === 1;
      });
    },

    async getMembershipRole(session) {
      return await withTenant(pool, session, async (database) => {
        const result = await database.query<{ role: MemberRole }>("SELECT role FROM organization_memberships WHERE organization_id=$1 AND user_id=$2 LIMIT 1", [session.organizationId, session.userId]);
        const role = result.rows[0]?.role;
        if (!role) throw new Error("tenant membership is not visible");
        return role;
      });
    },
  };
}


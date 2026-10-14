import type { SessionIdentity } from "./auth.js";
import { assertUuid, type MemberRole, type TenantPool, type TenantQuery, withTenant } from "./database.js";
import { normalizeOrganizationSkillInput, organizationSkillMaxCount, type OrganizationSkill } from "../../../packages/db/src/organization-skills.js";

export type OrganizationSkillInput = { readonly title: string; readonly body: string; readonly appliesToStacks: readonly string[] | null };
export type OrganizationSkillContext = { readonly organizationName: string; readonly userEmail: string | null; readonly role: MemberRole };

export interface OrganizationSkillDatabase {
  context(session: SessionIdentity): Promise<OrganizationSkillContext>;
  list(session: Pick<SessionIdentity, "organizationId">): Promise<readonly OrganizationSkill[]>;
  create(session: SessionIdentity, input: OrganizationSkillInput): Promise<OrganizationSkill>;
  update(session: SessionIdentity, skillId: string, input: OrganizationSkillInput): Promise<boolean>;
  setEnabled(session: SessionIdentity, skillId: string, enabled: boolean): Promise<boolean>;
  remove(session: SessionIdentity, skillId: string): Promise<boolean>;
}

type SkillRow = { id: string; title: string; body: string; applies_to_stacks: string[] | null; enabled: boolean; updated_at: Date | string };
const columns = "id,title,body,applies_to_stacks,enabled,updated_at";
function skill(row: SkillRow): OrganizationSkill {
  return { id: row.id, title: row.title, body: row.body, appliesToStacks: row.applies_to_stacks, enabled: row.enabled, updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at };
}

// Shared by the API and the worker: every enabled and disabled rule of one
// organization, oldest first.
export async function listOrganizationSkills(database: { readonly query: TenantQuery }, organizationId: string): Promise<readonly OrganizationSkill[]> {
  const result = await database.query<SkillRow>(`SELECT ${columns} FROM organization_skills WHERE organization_id=$1 ORDER BY created_at, id LIMIT ${organizationSkillMaxCount}`, [organizationId]);
  return result.rows.map(skill);
}

export function createOrganizationSkillDatabase(pool: TenantPool): OrganizationSkillDatabase {
  return {
    async context(session) {
      return await withTenant(pool, session, async (database) => {
        const result = await database.query<{ name: string; email: string | null; role: MemberRole }>(
          `SELECT o.name,u.email,m.role FROM organizations o JOIN organization_memberships m ON m.organization_id=o.id JOIN users u ON u.id=m.user_id WHERE o.id=$1 AND m.user_id=$2 LIMIT 1`,
          [session.organizationId, session.userId],
        );
        const row = result.rows[0];
        if (!row) throw new Error("tenant membership is not visible");
        return { organizationName: row.name, userEmail: row.email, role: row.role };
      });
    },

    async list(session) {
      return await withTenant(pool, session, async (database) => await listOrganizationSkills(database, session.organizationId));
    },

    async create(session, input) {
      const value = normalizeOrganizationSkillInput(input);
      return await withTenant(pool, session, async (database) => {
        const count = await database.query<{ count: string }>("SELECT count(*)::text AS count FROM organization_skills WHERE organization_id=$1", [session.organizationId]);
        if (Number(count.rows[0]?.count ?? 0) >= organizationSkillMaxCount) throw new Error(`an organization can have at most ${organizationSkillMaxCount} rules`);
        const result = await database.query<SkillRow>(
          `INSERT INTO organization_skills (id,organization_id,title,body,applies_to_stacks,created_by) VALUES (gen_random_uuid(),$1,$2,$3,$4,$5) RETURNING ${columns}`,
          [session.organizationId, value.title, value.body, value.appliesToStacks, session.userId],
        );
        await database.query(`INSERT INTO audit_events (id,organization_id,actor_user_id,event_type,payload) VALUES (gen_random_uuid(),$1,$2,'organization_rule_created',jsonb_build_object('ruleId',$3::text))`, [session.organizationId, session.userId, result.rows[0]!.id]);
        return skill(result.rows[0]!);
      });
    },

    async update(session, skillId, input) {
      assertUuid(skillId, "skillId");
      const value = normalizeOrganizationSkillInput(input);
      return await withTenant(pool, session, async (database) => {
        const result = await database.query<{ id: string }>(
          "UPDATE organization_skills SET title=$3,body=$4,applies_to_stacks=$5,updated_at=now() WHERE organization_id=$1 AND id=$2 RETURNING id",
          [session.organizationId, skillId, value.title, value.body, value.appliesToStacks],
        );
        if (result.rows.length === 1) await database.query(`INSERT INTO audit_events (id,organization_id,actor_user_id,event_type,payload) VALUES (gen_random_uuid(),$1,$2,'organization_rule_updated',jsonb_build_object('ruleId',$3::text))`, [session.organizationId, session.userId, skillId]);
        return result.rows.length === 1;
      });
    },

    async setEnabled(session, skillId, enabled) {
      assertUuid(skillId, "skillId");
      return await withTenant(pool, session, async (database) => {
        const result = await database.query<{ id: string }>("UPDATE organization_skills SET enabled=$3,updated_at=now() WHERE organization_id=$1 AND id=$2 RETURNING id", [session.organizationId, skillId, enabled]);
        return result.rows.length === 1;
      });
    },

    async remove(session, skillId) {
      assertUuid(skillId, "skillId");
      return await withTenant(pool, session, async (database) => {
        const result = await database.query<{ id: string }>("DELETE FROM organization_skills WHERE organization_id=$1 AND id=$2 RETURNING id", [session.organizationId, skillId]);
        if (result.rows.length === 1) await database.query(`INSERT INTO audit_events (id,organization_id,actor_user_id,event_type,payload) VALUES (gen_random_uuid(),$1,$2,'organization_rule_deleted',jsonb_build_object('ruleId',$3::text))`, [session.organizationId, session.userId, skillId]);
        return result.rows.length === 1;
      });
    },
  };
}

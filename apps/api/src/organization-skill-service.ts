import type { SessionIdentity } from "./auth.js";
import type { MemberRole } from "./database.js";
import { AppError } from "./errors.js";
import type { OrganizationSkillDatabase, OrganizationSkillInput } from "./organization-skill-database.js";
import { enabledOrganizationRulesChars, organizationRulesMaxChars, organizationSkillBodyMaxChars, organizationSkillTitleMaxChars, type OrganizationSkill } from "../../../packages/db/src/organization-skills.js";
import { loadBuiltInStackSkillsSync } from "../../../packages/skills/src/registry.js";

export type OrganizationSkillsView = {
  readonly organization: { readonly name: string };
  readonly currentUser: { readonly email: string | null; readonly role: MemberRole };
  readonly rules: readonly OrganizationSkill[];
  readonly stacks: readonly { readonly id: string; readonly displayName: string }[];
  readonly limits: { readonly titleMaxChars: number; readonly bodyMaxChars: number; readonly promptMaxChars: number; readonly enabledChars: number };
};

export interface OrganizationSkillService {
  view(session: SessionIdentity): Promise<OrganizationSkillsView>;
  create(session: SessionIdentity, input: OrganizationSkillInput): Promise<void>;
  update(session: SessionIdentity, skillId: string, input: OrganizationSkillInput): Promise<void>;
  setEnabled(session: SessionIdentity, skillId: string, enabled: boolean): Promise<void>;
  remove(session: SessionIdentity, skillId: string): Promise<void>;
}

export function createOrganizationSkillService(options: { readonly database: OrganizationSkillDatabase }): OrganizationSkillService {
  const stacks = [...loadBuiltInStackSkillsSync().values()].map((skill) => ({ id: skill.id, displayName: skill.displayName })).sort((left, right) => left.displayName.localeCompare(right.displayName));
  const knownStacks = new Set(stacks.map((stack) => stack.id));
  const requireOwner = async (session: SessionIdentity) => {
    if ((await options.database.context(session)).role !== "owner") throw new AppError("ORGANIZATION_RULE_FORBIDDEN", "Only an organization owner can change coding rules.", 403);
  };
  const validated = (input: OrganizationSkillInput): OrganizationSkillInput => {
    if (input.appliesToStacks?.some((stack) => !knownStacks.has(stack))) throw new AppError("ORGANIZATION_RULE_INVALID", "Choose stacks from the list.", 400);
    return input;
  };
  const invalid = (error: unknown): never => {
    if (error instanceof Error && /^(rule |an organization can have)/.test(error.message)) throw new AppError("ORGANIZATION_RULE_INVALID", `${error.message.charAt(0).toUpperCase()}${error.message.slice(1)}.`, 400);
    throw error;
  };
  const found = (ok: boolean) => { if (!ok) throw new AppError("ORGANIZATION_RULE_NOT_FOUND", "That rule was not found.", 404); };
  return {
    async view(session) {
      const [context, rules] = await Promise.all([options.database.context(session), options.database.list(session)]);
      return {
        organization: { name: context.organizationName },
        currentUser: { email: context.userEmail, role: context.role },
        rules,
        stacks,
        limits: { titleMaxChars: organizationSkillTitleMaxChars, bodyMaxChars: organizationSkillBodyMaxChars, promptMaxChars: organizationRulesMaxChars, enabledChars: enabledOrganizationRulesChars(rules) },
      };
    },
    async create(session, input) { await requireOwner(session); await options.database.create(session, validated(input)).catch(invalid); },
    async update(session, skillId, input) { await requireOwner(session); found(await options.database.update(session, skillId, validated(input)).catch(invalid)); },
    async setEnabled(session, skillId, enabled) { await requireOwner(session); found(await options.database.setEnabled(session, skillId, enabled)); },
    async remove(session, skillId) { await requireOwner(session); found(await options.database.remove(session, skillId)); },
  };
}

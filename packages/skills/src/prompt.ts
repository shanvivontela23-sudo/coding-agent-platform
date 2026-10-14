import { resolveStoredProjectReport, type StoredProjectReport } from "./resolution.js";
import type { StackSkill } from "./schema.js";

export type StackPromptContext = {
  readonly clarificationLabel: string | null;
  readonly trustedGuidePrefix: string;
  readonly planningSkillId: string | null;
  readonly planningSkillVersion: string | null;
};

export function stackPromptContext(report: StoredProjectReport, skills: ReadonlyMap<string, StackSkill>): StackPromptContext {
  const resolved = resolveStoredProjectReport(report, skills);
  if (!resolved.skillVersion) return { clarificationLabel: null, trustedGuidePrefix: "", planningSkillId: null, planningSkillVersion: null };
  const skill = skills.get(resolved.skillId);
  if (!skill || skill.version !== resolved.skillVersion) return { clarificationLabel: null, trustedGuidePrefix: "", planningSkillId: null, planningSkillVersion: null };
  return {
    clarificationLabel: skill.displayName,
    trustedGuidePrefix: `<TRUSTED_STACK_SKILL id="${skill.id}" version="${skill.version}">\n${skill.guide}\n</TRUSTED_STACK_SKILL>`,
    planningSkillId: skill.id,
    planningSkillVersion: skill.version,
  };
}

export type Phase0LiveConfig = {
  readonly e2bTemplateId: string;
};

export function loadPhase0LiveConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Phase0LiveConfig {
  const e2bTemplateId = env.E2B_TEMPLATE_ID?.trim();
  if (!e2bTemplateId) throw new Error("E2B_TEMPLATE_ID is required for Phase 0 live runs");
  return { e2bTemplateId };
}

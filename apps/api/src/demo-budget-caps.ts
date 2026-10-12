export type DemoBudgetCaps = { readonly planningUsd: number; readonly executionUsd: number };

function positive(name: string, raw: string | undefined, fallback: number): number {
  const value = raw?.trim() ? Number(raw) : fallback;
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be greater than zero`);
  return value;
}

export function resolveDemoBudgetCaps(env: Readonly<Record<string, string | undefined>>): DemoBudgetCaps {
  return {
    planningUsd: positive("TASK_MODEL_BUDGET_USD", env.TASK_MODEL_BUDGET_USD, 1),
    executionUsd: positive("TASK_EXECUTION_BUDGET_USD", env.TASK_EXECUTION_BUDGET_USD, 2),
  };
}

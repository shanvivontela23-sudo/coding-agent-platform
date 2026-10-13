import { readFile } from "node:fs/promises";

export const DEMO_DEFAULTS = {
  apiPort: 3101,
  webPort: 3000,
  planningBudgetUsd: 1,
  executionBudgetUsd: 2,
} as const;

const requiredNames = [
  "DEMO_DATABASE_ADMIN_URL",
  "DEMO_API_DATABASE_URL",
  "DEMO_WORKER_DATABASE_URL",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_FLOW_SECRET",
  "SESSION_SIGNING_SECRET",
  "GITHUB_APP_ID",
  "GITHUB_APP_SLUG",
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_CLIENT_SECRET",
  "GITHUB_APP_PRIVATE_KEY",
  "E2B_API_KEY",
  "E2B_TEMPLATE_ID",
  "TASK_EXECUTION_MODEL",
  "TASK_EXECUTION_CODEX_VERSION",
  "MODEL_GATEWAY_RUN_TOKEN_SECRET",
  "LITELLM_MASTER_KEY",
  "POSTGRES_PASSWORD",
  "ANTHROPIC_API_KEY",
  "TASK_MODEL_NAME",
  "HARNESS_MODEL_PRICES_JSON",
  "NGROK_AUTHTOKEN",
] as const;

export type DemoConfig = {
  readonly apiPort: number;
  readonly webPort: number;
  readonly planningBudgetUsd: number;
  readonly executionBudgetUsd: number;
  readonly values: Readonly<Record<string, string>>;
};

export type DemoEnvironmentResult =
  | { readonly ok: true; readonly config: DemoConfig }
  | { readonly ok: false; readonly missing: readonly string[]; readonly message: string };

function positiveNumber(name: string, value: string | undefined, fallback: number): number {
  const parsed = value?.trim() ? Number(value) : fallback;
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be greater than zero`);
  return parsed;
}

export function parseDotEnv(contents: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    result[key] = value.replaceAll("\\n", "\n");
  }
  return result;
}

export async function readRootDotEnv(path = ".env"): Promise<Record<string, string>> {
  return parseDotEnv(await readFile(path, "utf8"));
}

export function loadDemoEnvironment(env: Readonly<Record<string, string | undefined>>): DemoEnvironmentResult {
  const missing = requiredNames.filter((name) => !env[name]?.trim());
  if (missing.length > 0) return { ok: false, missing, message: `Missing demo configuration: ${missing.join(", ")}` };
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) if (value !== undefined) values[name] = value;
  return {
    ok: true,
    config: {
      apiPort: DEMO_DEFAULTS.apiPort,
      webPort: DEMO_DEFAULTS.webPort,
      planningBudgetUsd: positiveNumber("TASK_MODEL_BUDGET_USD", env.TASK_MODEL_BUDGET_USD, DEMO_DEFAULTS.planningBudgetUsd),
      executionBudgetUsd: positiveNumber("TASK_EXECUTION_BUDGET_USD", env.TASK_EXECUTION_BUDGET_USD, DEMO_DEFAULTS.executionBudgetUsd),
      values,
    },
  };
}

export function publicDemoSummary(config: DemoConfig): string {
  return [
    `API: http://localhost:${config.apiPort}`,
    `Web: http://localhost:${config.webPort}`,
    `Planning cap: $${config.planningBudgetUsd.toFixed(2)}`,
    `Implementation cap: $${config.executionBudgetUsd.toFixed(2)}`,
  ].join("\n");
}

export function secretValues(config: DemoConfig): readonly string[] {
  const secretName = /(SECRET|TOKEN|KEY|PASSWORD|DATABASE_URL)/i;
  return Object.entries(config.values)
    .filter(([name, value]) => secretName.test(name) && value.length >= 4)
    .map(([, value]) => value)
    .sort((a, b) => b.length - a.length);
}

export function redactDemoSecrets(text: string, config: DemoConfig): string {
  let safe = text;
  for (const value of secretValues(config)) safe = safe.split(value).join("[REDACTED]");
  return safe;
}

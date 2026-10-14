import { homedir } from "node:os";
import { join } from "node:path";
import type { DemoConfig } from "./config.js";
import { redactDemoSecrets } from "./config.js";

export type DemoProcessPlan = {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
};
export type DemoLaunchPlan = {
  readonly compose: DemoProcessPlan;
  readonly ngrok: DemoProcessPlan;
  readonly api: DemoProcessPlan;
  readonly web: DemoProcessPlan;
  readonly worker: DemoProcessPlan;
};

function value(config: DemoConfig, name: string, fallback = ""): string {
  return config.values[name]?.trim() || fallback;
}
function pick(config: DemoConfig, names: readonly string[]): Record<string, string> {
  return Object.fromEntries(names.flatMap((name) => {
    const selected = config.values[name]?.trim();
    return selected ? [[name, selected] as const] : [];
  }));
}

// publicOrigin (DEMO_SHARE=1): one public HTTPS origin in front of the share
// proxy, so browsers on other machines reach both web and API under one host.
export function createDemoLaunchPlan(config: DemoConfig, tunnelUrl: string, cwd = process.cwd(), publicOrigin?: string): DemoLaunchPlan {
  if (!/^https:\/\//.test(tunnelUrl)) throw new Error("Demo gateway tunnel must use HTTPS");
  if (publicOrigin !== undefined && !/^https:\/\/[^/]+$/.test(publicOrigin)) throw new Error("Demo share origin must be an HTTPS origin with no path");
  const apiOrigin = publicOrigin ?? `http://localhost:${config.apiPort}`;
  const webOrigin = publicOrigin ?? `http://localhost:${config.webPort}`;
  const storageRoot = value(config, "PROJECT_STORAGE_ROOT", join(homedir(), ".dhara", "storage"));
  const gatewayState = join(cwd, ".local", "gateway-state");
  const apiEnv: Record<string, string | undefined> = {
    ...pick(config, [
      "SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_FLOW_SECRET", "SESSION_SIGNING_SECRET",
      "GITHUB_APP_ID", "GITHUB_APP_SLUG", "GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET", "GITHUB_APP_PRIVATE_KEY",
      "TASK_MODEL_NAME", "TASK_MODEL_PROVIDER", "TASK_TICKET_ENCRYPTION_SECRET",
    ]),
    DATABASE_URL: value(config, "DEMO_API_DATABASE_URL"),
    PORT: String(config.apiPort),
    API_ORIGIN: apiOrigin,
    WEB_ORIGIN: webOrigin,
    DEMO_MODE: "1",
    TASK_MODEL_GATEWAY_BASE_URL: "http://127.0.0.1:4000",
    TASK_MODEL_GATEWAY_ADMIN_TOKEN: value(config, "LITELLM_MASTER_KEY"),
    TASK_MODEL_PROVIDER: value(config, "TASK_MODEL_PROVIDER", "anthropic"),
    TASK_MODEL_BUDGET_USD: String(config.planningBudgetUsd),
    TASK_EXECUTION_BUDGET_USD: String(config.executionBudgetUsd),
    TASK_GATEWAY_RUN_TOKEN_SECRET: value(config, "MODEL_GATEWAY_RUN_TOKEN_SECRET"),
    TASK_TICKET_ENCRYPTION_SECRET: value(config, "TASK_TICKET_ENCRYPTION_SECRET", value(config, "SESSION_SIGNING_SECRET")),
    PROJECT_STORAGE_ROOT: storageRoot,
  };
  const webEnv: Record<string, string | undefined> = {
    NEXT_PUBLIC_API_ORIGIN: apiOrigin,
    PORT: String(config.webPort),
    // Next.js dev blocks its dev assets for non-localhost origins unless listed.
    ...(publicOrigin ? { NEXT_ALLOWED_DEV_ORIGINS: new URL(publicOrigin).hostname } : {}),
  };
  const workerEnv: Record<string, string | undefined> = {
    // Optional per-stack templates (E2B_TEMPLATE_<SKILL_KEY>); unset keys fall
    // back to E2B_TEMPLATE_ID inside the worker.
    ...pick(config, Object.keys(config.values).filter((name) => /^E2B_TEMPLATE_[A-Z0-9_]+$/.test(name) && name !== "E2B_TEMPLATE_ID")),
    ...pick(config, ["E2B_API_KEY", "E2B_TEMPLATE_ID", "TASK_EXECUTION_MODEL", "TASK_EXECUTION_CODEX_VERSION", "MODEL_GATEWAY_RUN_TOKEN_SECRET", "GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY"]),
    DATABASE_URL: value(config, "DEMO_WORKER_DATABASE_URL"),
    TASK_EXECUTION_WORKER_ID: value(config, "TASK_EXECUTION_WORKER_ID", "demo-worker-1"),
    TASK_EXECUTION_GATEWAY_URL: tunnelUrl,
    LITELLM_GATEWAY_URL: "http://127.0.0.1:4000",
    LITELLM_ADMIN_TOKEN: value(config, "LITELLM_MASTER_KEY"),
    GATEWAY_STORE_DIR: join(gatewayState, "gateway"),
    HARNESS_CALL_STORE_DIR: join(gatewayState, "http"),
    PROJECT_STORAGE_ROOT: storageRoot,
    TASK_EXECUTION_FAKE_RUNNER: undefined,
  };
  const composeEnv: Record<string, string | undefined> = {
    ...pick(config, ["MODEL_GATEWAY_RUN_TOKEN_SECRET", "LITELLM_MASTER_KEY", "POSTGRES_PASSWORD", "ANTHROPIC_API_KEY", "HARNESS_MODEL_PRICES_JSON"]),
    GATEWAY_HOSTNAME: "0.0.0.0",
    HARNESS_MODEL_PRICES_JSON: value(config, "HARNESS_MODEL_PRICES_JSON", "{}"),
    LOCAL_GATEWAY_STATE_DIR: gatewayState,
  };
  return {
    compose: { command: "docker", args: ["compose", "--env-file", ".env", "-f", "evals/deploy/http-gateway/compose.local.yaml", "up", "-d", "--build"], env: composeEnv },
    ngrok: { command: "ngrok", args: ["http", "8080", "--log=stdout", "--log-format=json"], env: { NGROK_AUTHTOKEN: value(config, "NGROK_AUTHTOKEN") } },
    api: { command: "pnpm", args: ["--filter", "@coding-agent/api", "dev"], env: apiEnv },
    web: { command: "pnpm", args: ["--filter", "@coding-agent/web", "dev"], env: webEnv },
    worker: { command: "pnpm", args: ["--filter", "@coding-agent/worker", "dev"], env: workerEnv },
  };
}

export function publicLaunchPlan(plan: DemoLaunchPlan, config: DemoConfig): string {
  const rows = [
    `compose: ${plan.compose.command} ${plan.compose.args.join(" ")}`,
    `ngrok: ${plan.ngrok.command} ${plan.ngrok.args.join(" ")}`,
    `api: ${plan.api.command} ${plan.api.args.join(" ")}`,
    `web: ${plan.web.command} ${plan.web.args.join(" ")}`,
    `worker: ${plan.worker.command} ${plan.worker.args.join(" ")}`,
  ];
  return redactDemoSecrets(rows.join("\n"), config);
}

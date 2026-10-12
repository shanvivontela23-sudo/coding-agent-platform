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

export function createDemoLaunchPlan(config: DemoConfig, tunnelUrl: string, cwd = process.cwd()): DemoLaunchPlan {
  if (!/^https:\/\//.test(tunnelUrl)) throw new Error("Demo gateway tunnel must use HTTPS");
  const storageRoot = value(config, "PROJECT_STORAGE_ROOT", join(homedir(), ".dhara", "storage"));
  const gatewayState = join(cwd, ".local", "gateway-state");
  const common = { ...config.values } as Record<string, string | undefined>;
  const apiEnv: Record<string, string | undefined> = {
    ...common,
    DATABASE_URL: value(config, "DEMO_API_DATABASE_URL"),
    PORT: String(config.apiPort),
    API_ORIGIN: `http://localhost:${config.apiPort}`,
    WEB_ORIGIN: `http://localhost:${config.webPort}`,
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
    ...common,
    NEXT_PUBLIC_API_ORIGIN: `http://localhost:${config.apiPort}`,
  };
  const workerEnv: Record<string, string | undefined> = {
    ...common,
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
    ...common,
    GATEWAY_HOSTNAME: "0.0.0.0",
    HARNESS_MODEL_PRICES_JSON: value(config, "HARNESS_MODEL_PRICES_JSON", "{}"),
    LOCAL_GATEWAY_STATE_DIR: gatewayState,
  };
  return {
    compose: { command: "docker", args: ["compose", "--env-file", ".env", "-f", "evals/deploy/http-gateway/compose.local.yaml", "up", "-d", "--build"], env: composeEnv },
    ngrok: { command: "ngrok", args: ["http", "8080", "--log=stdout", "--log-format=json"], env: { ...common, NGROK_AUTHTOKEN: value(config, "NGROK_AUTHTOKEN") } },
    api: { command: "pnpm", args: ["--filter", "@coding-agent/api", "dev"], env: apiEnv },
    web: { command: "pnpm", args: ["--filter", "@coding-agent/web", "dev", "--", "-p", String(config.webPort)], env: webEnv },
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

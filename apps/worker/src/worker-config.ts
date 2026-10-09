export type RealWorkerConfig = {
  readonly databaseUrl: string;
  readonly workerId: string;
  readonly e2bApiKey: string;
  readonly model: string;
  readonly codexVersion: string;
  readonly gatewayUrl: string;
  readonly runTokenSecret: string;
  readonly gatewayStoreDir: string;
  readonly harnessCallStoreDir: string;
  readonly litellmGatewayUrl: string;
  readonly litellmAdminToken: string;
  readonly githubAppId: string;
  readonly githubAppPrivateKey: string;
  readonly projectStorageRoot: string;
};

const realRequired = [
  "DATABASE_URL",
  "TASK_EXECUTION_WORKER_ID",
  "E2B_API_KEY",
  "TASK_EXECUTION_MODEL",
  "TASK_EXECUTION_CODEX_VERSION",
  "TASK_EXECUTION_GATEWAY_URL",
  "MODEL_GATEWAY_RUN_TOKEN_SECRET",
  "GATEWAY_STORE_DIR",
  "HARNESS_CALL_STORE_DIR",
  "LITELLM_GATEWAY_URL",
  "LITELLM_ADMIN_TOKEN",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "PROJECT_STORAGE_ROOT",
] as const;

export function loadRealWorkerConfig(env: Readonly<Record<string, string | undefined>> = process.env): RealWorkerConfig {
  const missing = realRequired.filter((name) => !env[name]?.trim());
  if (missing.length > 0) throw new Error(`Missing worker configuration: ${missing.join(", ")}`);
  return {
    databaseUrl: env.DATABASE_URL!.trim(),
    workerId: env.TASK_EXECUTION_WORKER_ID!.trim(),
    e2bApiKey: env.E2B_API_KEY!.trim(),
    model: env.TASK_EXECUTION_MODEL!.trim(),
    codexVersion: env.TASK_EXECUTION_CODEX_VERSION!.trim(),
    gatewayUrl: env.TASK_EXECUTION_GATEWAY_URL!.trim(),
    runTokenSecret: env.MODEL_GATEWAY_RUN_TOKEN_SECRET!.trim(),
    gatewayStoreDir: env.GATEWAY_STORE_DIR!.trim(),
    harnessCallStoreDir: env.HARNESS_CALL_STORE_DIR!.trim(),
    litellmGatewayUrl: env.LITELLM_GATEWAY_URL!.trim(),
    litellmAdminToken: env.LITELLM_ADMIN_TOKEN!.trim(),
    githubAppId: env.GITHUB_APP_ID!.trim(),
    githubAppPrivateKey: env.GITHUB_APP_PRIVATE_KEY!.trim(),
    projectStorageRoot: env.PROJECT_STORAGE_ROOT!.trim(),
  };
}

import { CodexHarnessRunner } from "../../../evals/src/harness/codex.js";
import { E2BSandboxProvider } from "../../../evals/src/sandbox/e2b-provider.js";
import type { TenantPool } from "../../api/src/database.js";
import { createRuntimePostgresPool } from "../../api/src/postgres-pool.js";
import { LocalProjectStorage } from "../../api/src/project-storage.js";
import { FileBackedExecutionGatewayControl } from "./execution-gateway.js";
import { PostgresExecutionStore } from "./execution-store.js";
import { runFakeTaskExecutionWorker, runTaskExecutionWorker } from "./main.js";
import { ProductCodingRunner } from "./product-coding-runner.js";
import { ProductExecutionOrchestrator } from "./product-execution-orchestrator.js";
import { GitHubInstallationArchiveReader, ProductExecutionSourceProvider } from "./product-execution-source.js";
import { loadRealWorkerConfig } from "./worker-config.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}
function assertWorkerDatabaseUrl(databaseUrl: string): void {
  const parsed = new URL(databaseUrl);
  if (decodeURIComponent(parsed.username) !== "coding_agent_worker") throw new Error("DATABASE_URL must use coding_agent_worker");
}

async function main(): Promise<void> {
  const fake = process.env.TASK_EXECUTION_FAKE_RUNNER === "1";
  const realConfig = fake ? null : loadRealWorkerConfig(process.env);
  const databaseUrl = realConfig?.databaseUrl ?? required("DATABASE_URL");
  const workerId = realConfig?.workerId ?? required("TASK_EXECUTION_WORKER_ID");
  assertWorkerDatabaseUrl(databaseUrl);

  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  const pool = createRuntimePostgresPool(databaseUrl, 4);

  try {
    if (fake) {
      await runFakeTaskExecutionWorker({ pool, databaseUsername: "coding_agent_worker", workerId, signal: controller.signal, env: process.env });
      return;
    }

    const config = realConfig!;
    const sandboxProvider = new E2BSandboxProvider({ apiKey: config.e2bApiKey });
    const harness = new CodexHarnessRunner({ version: config.codexVersion });
    const gateway = new FileBackedExecutionGatewayControl({
      gatewayUrl: config.gatewayUrl,
      model: config.model,
      runTokenSecret: config.runTokenSecret,
      gatewayStoreDir: config.gatewayStoreDir,
      harnessCallStoreDir: config.harnessCallStoreDir,
      litellmGatewayUrl: config.litellmGatewayUrl,
      litellmAdminToken: config.litellmAdminToken,
    });
    const zipLimits = {
      maxCompressedBytes: positiveInteger("PROJECT_UPLOAD_MAX_COMPRESSED_BYTES", 100 * 1024 * 1024),
      maxUncompressedBytes: positiveInteger("PROJECT_UPLOAD_MAX_UNCOMPRESSED_BYTES", 500 * 1024 * 1024),
      maxFiles: positiveInteger("PROJECT_UPLOAD_MAX_FILES", 50_000),
      maxFileBytes: positiveInteger("PROJECT_UPLOAD_MAX_FILE_BYTES", 5 * 1024 * 1024),
      maxNestedArchiveDepth: positiveInteger("PROJECT_UPLOAD_MAX_NESTED_ARCHIVE_DEPTH", 1),
    } as const;
    const tenantPool = pool as unknown as TenantPool;
    const sourceProvider = new ProductExecutionSourceProvider({
      pool: tenantPool,
      storage: new LocalProjectStorage({ rootDir: config.projectStorageRoot }),
      github: new GitHubInstallationArchiveReader({ appId: config.githubAppId, privateKey: config.githubAppPrivateKey }),
      zipLimits,
      maxGitHubArchiveBytes: positiveInteger("TASK_EXECUTION_GITHUB_ARCHIVE_MAX_BYTES", 100 * 1024 * 1024),
    });
    const store = new PostgresExecutionStore(tenantPool);
    const orchestrator = new ProductExecutionOrchestrator({
      store,
      sourceProvider,
      verificationSandboxProvider: sandboxProvider,
      patchLimits: { maxFiles: positiveInteger("TASK_EXECUTION_MAX_PATCH_FILES", 50), maxBytes: positiveInteger("TASK_EXECUTION_MAX_PATCH_BYTES", 2 * 1024 * 1024) },
      codingRuntimeFactory: async (execution) => {
        const gatewaySession = await gateway.open({ executionId: execution.executionId, budgetUsd: execution.budgetUsd, timeoutSeconds: execution.timeoutSeconds });
        return {
          runner: new ProductCodingRunner({
            sandboxProvider,
            harnessRunner: harness,
            route: { gatewayUrl: gatewaySession.gatewayUrl, runToken: gatewaySession.runToken, model: gatewaySession.model },
            readCostUsd: async () => await gatewaySession.readCostUsd(),
          }),
          close: async () => await gatewaySession.finish(),
        };
      },
    });
    await runTaskExecutionWorker({ pool, databaseUsername: "coding_agent_worker", workerId, signal: controller.signal, runner: orchestrator });
  } finally {
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "worker failed";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});

import { CodexHarnessRunner } from "../../../evals/src/harness/codex.js";
import { E2BSandboxProvider } from "../../../evals/src/sandbox/e2b-provider.js";
import type { TenantPool } from "../../api/src/database.js";
import { LocalProjectStorage } from "../../api/src/project-storage.js";
import { FileBackedExecutionGatewayControl, type ExecutionGatewayControl } from "./execution-gateway.js";
import { PostgresExecutionStore } from "./execution-store.js";
import { ProductCodingRunner } from "./product-coding-runner.js";
import { ProductExecutionOrchestrator } from "./product-execution-orchestrator.js";
import { GitHubInstallationArchiveReader, ProductExecutionSourceProvider } from "./product-execution-source.js";
import type { RestrictedQueryPool } from "./postgres-execution-queue.js";
import type { RealWorkerConfig } from "./worker-config.js";

function positiveInteger(env: Readonly<Record<string, string | undefined>>, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function createRealProductExecutionRunner(options: {
  readonly config: RealWorkerConfig;
  readonly pool: RestrictedQueryPool & Partial<TenantPool>;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly gateway?: ExecutionGatewayControl;
  readonly sandboxProvider?: E2BSandboxProvider;
  readonly harness?: CodexHarnessRunner;
}): ProductExecutionOrchestrator {
  const env = options.env ?? process.env;
  const tenantPool = options.pool as unknown as TenantPool;
  const sandboxProvider = options.sandboxProvider ?? new E2BSandboxProvider({ apiKey: options.config.e2bApiKey });
  const harness = options.harness ?? new CodexHarnessRunner({ version: options.config.codexVersion });
  const gateway = options.gateway ?? new FileBackedExecutionGatewayControl({
    gatewayUrl: options.config.gatewayUrl,
    model: options.config.model,
    runTokenSecret: options.config.runTokenSecret,
    gatewayStoreDir: options.config.gatewayStoreDir,
    harnessCallStoreDir: options.config.harnessCallStoreDir,
    litellmGatewayUrl: options.config.litellmGatewayUrl,
    litellmAdminToken: options.config.litellmAdminToken,
  });
  const sourceProvider = new ProductExecutionSourceProvider({
    pool: tenantPool,
    storage: new LocalProjectStorage({ rootDir: options.config.projectStorageRoot }),
    github: new GitHubInstallationArchiveReader({ appId: options.config.githubAppId, privateKey: options.config.githubAppPrivateKey }),
    zipLimits: {
      maxCompressedBytes: positiveInteger(env, "PROJECT_UPLOAD_MAX_COMPRESSED_BYTES", 100 * 1024 * 1024),
      maxUncompressedBytes: positiveInteger(env, "PROJECT_UPLOAD_MAX_UNCOMPRESSED_BYTES", 500 * 1024 * 1024),
      maxFiles: positiveInteger(env, "PROJECT_UPLOAD_MAX_FILES", 50_000),
      maxFileBytes: positiveInteger(env, "PROJECT_UPLOAD_MAX_FILE_BYTES", 5 * 1024 * 1024),
      maxNestedArchiveDepth: positiveInteger(env, "PROJECT_UPLOAD_MAX_NESTED_ARCHIVE_DEPTH", 1),
    },
    maxGitHubArchiveBytes: positiveInteger(env, "TASK_EXECUTION_GITHUB_ARCHIVE_MAX_BYTES", 100 * 1024 * 1024),
  });
  return new ProductExecutionOrchestrator({
    store: new PostgresExecutionStore(tenantPool),
    sourceProvider,
    verificationSandboxProvider: sandboxProvider,
    patchLimits: { maxFiles: positiveInteger(env, "TASK_EXECUTION_MAX_PATCH_FILES", 50), maxBytes: positiveInteger(env, "TASK_EXECUTION_MAX_PATCH_BYTES", 2 * 1024 * 1024) },
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
}

import { CodexHarnessRunner } from "../../../evals/src/harness/codex.js";
import type { HarnessRunner } from "../../../evals/src/harness/types.js";
import { E2BSandboxProvider } from "../../../evals/src/sandbox/e2b-provider.js";
import type { SandboxProvider } from "../../../evals/src/sandbox/types.js";
import type { TenantPool } from "../../api/src/database.js";
import { LocalProjectStorage } from "../../api/src/project-storage.js";
import { FileBackedExecutionGatewayControl, type ExecutionGatewayControl } from "./execution-gateway.js";
import type { ExecutionSourceProvider } from "./execution-source.js";
import { PostgresExecutionStore } from "./execution-store.js";
import { ProductCodingRunner } from "./product-coding-runner.js";
import { ProductExecutionOrchestrator } from "./product-execution-orchestrator.js";
import { GitHubInstallationArchiveReader, ProductExecutionSourceProvider } from "./product-execution-source.js";
import type { RestrictedQueryPool } from "./postgres-execution-queue.js";
import type { RealWorkerConfig } from "./worker-config.js";
import { buildExecutionProfile, parseExecutionProfile, resolveSandboxTemplateId } from "../../../packages/skills/src/profile.js";
import { applicableOrganizationRules, boundedOrganizationRules } from "../../../packages/db/src/organization-skills.js";
import { loadBuiltInStackSkillsSync } from "../../../packages/skills/src/registry.js";
import type { StackSkill } from "../../../packages/skills/src/schema.js";

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
  readonly sandboxProvider?: SandboxProvider;
  readonly harness?: HarnessRunner;
  readonly sourceProvider?: ExecutionSourceProvider;
  readonly skills?: ReadonlyMap<string, StackSkill>;
}): ProductExecutionOrchestrator {
  const env = options.env ?? process.env;
  const skills = options.skills ?? loadBuiltInStackSkillsSync();
  const tenantPool = options.pool as unknown as TenantPool;
  const sandboxProvider = options.sandboxProvider ?? new E2BSandboxProvider({ apiKey: options.config.e2bApiKey, defaultTemplate: options.config.e2bTemplateId });
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
  const sourceProvider = options.sourceProvider ?? new ProductExecutionSourceProvider({
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
    resolveProfile: (source) => {
      // A source without a stored report degrades to generic with its own commands.
      const report = source.report ?? { stackSkill: "generic", packageManager: null, installCommand: source.commands.install, testCommand: source.commands.test, buildCommand: source.commands.build, manifests: [] };
      const profile = buildExecutionProfile({ report, skills, planningSkill: source.planningSkill ?? null, sandboxTemplateId: (key) => resolveSandboxTemplateId(key, env, options.config.e2bTemplateId) });
      const rules = boundedOrganizationRules(applicableOrganizationRules(source.organizationSkills ?? [], profile.skillId)).included;
      return rules.length > 0 ? parseExecutionProfile({ ...profile, organizationRules: rules }) : profile;
    },
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

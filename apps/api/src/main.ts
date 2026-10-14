import { homedir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { handlePoolErrors } from "./postgres-pool.js";
import { FileGatewayStore } from "../../../evals/src/gateway/file-store.js";
import { LiteLLMAdapter } from "../../../evals/src/gateway/litellm-adapter.js";
import { PersistentModelGateway } from "../../../evals/src/gateway/model-gateway.js";
import { RunTokenService } from "../../../evals/src/gateway/run-token.js";
import { createSupabaseAuthClient } from "./auth.js";
import { assertRestrictedDatabaseUrl, createProductDatabase, type TenantPool } from "./database.js";
import { resolveDemoBudgetCaps } from "./demo-budget-caps.js";
import { createGitHubAppClient } from "./github-app.js";
import { createGitHubInstallationPermissionReader } from "./github-installation-permissions.js";
import { GitHubRestPublicationClient } from "./github-publication-client.js";
import { GitHubExecutionPublisher } from "./github-publication.js";
import { HybridProjectCodeReader } from "./hybrid-project-code-reader.js";
import { ProjectDownloadTokenService } from "./project-download-token.js";
import { GitHubProjectCodeReader } from "./project-code-reader.js";
import { LocalProjectStorage } from "./project-storage.js";
import { attachProduct07Routes } from "./product-07-server.js";
import { createProduct07Service } from "./product-07-service.js";
import { createApiServer } from "./server.js";
import { createTaskDatabase } from "./task-database.js";
import { createTaskExecutionDatabase } from "./task-execution-database.js";
import { createTaskExecutionReadinessReader } from "./task-execution-readiness.js";
import { attachTaskExecutionRoutes } from "./task-execution-server.js";
import { createTaskExecutionService } from "./task-execution-service.js";
import { ExistingGatewayTaskModelGateway } from "./task-intake.js";
import { createTaskPublicationDatabase } from "./task-publication-database.js";
import { createTaskPublicationService } from "./task-publication-service.js";
import { attachTaskRoutes } from "./task-server.js";
import { createTaskPlanningService, createTaskReadService, type TaskPlanningService } from "./task-service.js";
import { createTaskZipResultDatabase } from "./task-zip-result-database.js";
import { createTaskZipResultService } from "./task-zip-result.js";
import { createTicketCipher } from "./ticket-crypto.js";
import { createUploadProjectDatabase } from "./upload-project-database.js";
import type { UploadArchiveLimits } from "./upload-archive.js";
import { validateBuiltInStackSkillsAtStartup } from "../../../packages/skills/src/registry.js";
import { createProjectDecisionDatabase } from "./project-decision-database.js";
import { attachProjectDecisionRoutes } from "./project-decision-http.js";
import { createProjectDecisionService } from "./project-decision-service.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function positiveNumber(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be greater than zero`);
  return value;
}
function positiveInteger(name: string, fallback: number): number {
  const value = positiveNumber(name, fallback);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be a positive integer`);
  return value;
}

// Before any pool or listener: a broken built-in stack skill stops startup.
validateBuiltInStackSkillsAtStartup("API");

const port = Number.parseInt(process.env.PORT ?? "3001", 10);
if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("PORT must be a valid TCP port");
const apiOrigin = process.env.API_ORIGIN ?? `http://localhost:${port}`;
const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:3000";
const sessionSecret = required("SESSION_SIGNING_SECRET");
const demoBudgetCaps = process.env.DEMO_MODE === "1" ? resolveDemoBudgetCaps(process.env) : null;
const executionBudgetUsd = demoBudgetCaps?.executionUsd ?? positiveNumber("TASK_EXECUTION_BUDGET_USD", 2);
const planningBudgetUsd = demoBudgetCaps?.planningUsd ?? positiveNumber("TASK_MODEL_BUDGET_USD", 0.5);

const databaseUrl = assertRestrictedDatabaseUrl(required("DATABASE_URL"));
const pool = handlePoolErrors(new Pool({ connectionString: databaseUrl }));
const tenantPool = pool as unknown as TenantPool;
const database = createProductDatabase(tenantPool);
const projectDecisionService = createProjectDecisionService({ database: createProjectDecisionDatabase(tenantPool) });
const auth = createSupabaseAuthClient({
  supabaseUrl: required("SUPABASE_URL"),
  anonKey: required("SUPABASE_ANON_KEY"),
  flowSecret: required("SUPABASE_FLOW_SECRET"),
});
const githubAppId = required("GITHUB_APP_ID");
const githubPrivateKey = required("GITHUB_APP_PRIVATE_KEY");
const githubApp = createGitHubAppClient({
  appId: githubAppId,
  appSlug: required("GITHUB_APP_SLUG"),
  clientId: required("GITHUB_APP_CLIENT_ID"),
  clientSecret: required("GITHUB_APP_CLIENT_SECRET"),
  privateKey: githubPrivateKey,
});
const githubPermissions = createGitHubInstallationPermissionReader({ appId: githubAppId, privateKey: githubPrivateKey });
const githubPublicationClient = new GitHubRestPublicationClient({ appId: githubAppId, privateKey: githubPrivateKey });

const uploadLimits: UploadArchiveLimits = {
  maxCompressedBytes: positiveInteger("PROJECT_UPLOAD_MAX_COMPRESSED_BYTES", 100 * 1024 * 1024),
  maxUncompressedBytes: positiveInteger("PROJECT_UPLOAD_MAX_UNCOMPRESSED_BYTES", 500 * 1024 * 1024),
  maxFiles: positiveInteger("PROJECT_UPLOAD_MAX_FILES", 50_000),
  maxFileBytes: positiveInteger("PROJECT_UPLOAD_MAX_FILE_BYTES", 5 * 1024 * 1024),
  maxNestedArchiveDepth: 1,
};
const uploadDatabase = createUploadProjectDatabase(tenantPool);
const projectStorage = new LocalProjectStorage({ rootDir: process.env.PROJECT_STORAGE_ROOT?.trim() || join(homedir(), ".dhara", "storage") });
const projectDownloadTokens = new ProjectDownloadTokenService({ secret: process.env.PROJECT_DOWNLOAD_TOKEN_SECRET?.trim() || sessionSecret });
const product07Service = createProduct07Service({
  database: uploadDatabase,
  productDatabase: database,
  storage: projectStorage,
  githubApp,
  downloadTokens: projectDownloadTokens,
  limits: uploadLimits,
});

const taskDatabase = createTaskDatabase(tenantPool);
const taskCipher = createTicketCipher(process.env.TASK_TICKET_ENCRYPTION_SECRET?.trim() || sessionSecret);
const taskReadService = createTaskReadService({ database: taskDatabase, cipher: taskCipher });
const taskExecutionService = createTaskExecutionService({
  database: createTaskExecutionDatabase(tenantPool),
  readinessReader: createTaskExecutionReadinessReader(tenantPool),
  githubApp: githubPermissions,
  budgetUsd: executionBudgetUsd,
  timeoutSeconds: positiveInteger("TASK_EXECUTION_TIMEOUT_SECONDS", 20 * 60),
});
const taskPublicationService = createTaskPublicationService({
  database: createTaskPublicationDatabase(tenantPool),
  publisher: new GitHubExecutionPublisher(githubPublicationClient),
  githubApp: githubPermissions,
});
const taskZipResultService = createTaskZipResultService({
  database: createTaskZipResultDatabase(tenantPool),
  storage: projectStorage,
  downloadTokens: projectDownloadTokens,
  limits: uploadLimits,
});
let taskPlanningService: TaskPlanningService | undefined;
const taskGatewayAdminToken = process.env.TASK_MODEL_GATEWAY_ADMIN_TOKEN?.trim();
if (taskGatewayAdminToken) {
  const taskRunTokenService = new RunTokenService({ secret: process.env.TASK_GATEWAY_RUN_TOKEN_SECRET?.trim() || sessionSecret });
  const gateway = new PersistentModelGateway({
    store: new FileGatewayStore({ rootDir: process.env.TASK_GATEWAY_STORE_DIR?.trim() || join(homedir(), ".dhara", "gateway") }),
    adapter: new LiteLLMAdapter({ baseUrl: required("TASK_MODEL_GATEWAY_BASE_URL"), adminToken: taskGatewayAdminToken }),
    tokenService: taskRunTokenService,
  });
  const taskModelGateway = new ExistingGatewayTaskModelGateway({
    gateway,
    tokenService: taskRunTokenService,
    provider: process.env.TASK_MODEL_PROVIDER?.trim() || "anthropic",
    model: required("TASK_MODEL_NAME"),
    runDurationMs: 7 * 24 * 60 * 60_000,
  });
  const githubReader = new GitHubProjectCodeReader({ database: taskDatabase, appId: githubAppId, privateKey: githubPrivateKey });
  taskPlanningService = createTaskPlanningService({
    database: taskDatabase,
    codeReader: new HybridProjectCodeReader({ uploadDatabase, storage: projectStorage, githubReader, limits: uploadLimits }),
    gateway: taskModelGateway,
    cipher: taskCipher,
    modelBudgetUsd: planningBudgetUsd,
  });
}

const productServer = createApiServer({
  webOrigin,
  apiOrigin,
  sessionSecret,
  sessionDurationMs: 8 * 60 * 60_000,
  onboardingDurationMs: 15 * 60_000,
  auth,
  database,
  githubApp,
});
const product07Server = attachProduct07Routes(productServer, { apiOrigin, webOrigin, sessionSecret, service: product07Service, maxUploadRequestBytes: uploadLimits.maxCompressedBytes + 1024 * 1024 });
const projectDecisionServer = attachProjectDecisionRoutes(product07Server, { apiOrigin, webOrigin, sessionSecret, service: projectDecisionService });
const taskServer = attachTaskRoutes(projectDecisionServer, { apiOrigin, webOrigin, sessionSecret, readService: taskReadService, planningService: taskPlanningService });
const server = attachTaskExecutionRoutes(taskServer, { apiOrigin, sessionSecret, service: taskExecutionService, publicationService: taskPublicationService, zipResultService: taskZipResultService, demoBudgetCaps });

server.listen(port, "127.0.0.1", () => { process.stdout.write(`coding-agent api listening on http://127.0.0.1:${port}\n`); });
const shutdown = () => { server.close(() => { void pool.end().finally(() => process.exit(0)); }); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

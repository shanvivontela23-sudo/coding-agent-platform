import { createRuntimePostgresPool } from "../../api/src/postgres-pool.js";
import { LocalProjectStorage } from "../../api/src/project-storage.js";
import { runFakeTaskExecutionWorker, runTaskExecutionWorker } from "./main.js";
import { PostgresZipResultArtifactStore, PostgresZipResultBuildQueue } from "./postgres-zip-result-build-queue.js";
import { createRealProductExecutionRunner } from "./real-worker.js";
import { loadRealWorkerConfig } from "./worker-config.js";
import { createZipResultBuilder } from "./zip-result-builder.js";

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
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const pool = createRuntimePostgresPool(databaseUrl, 4);

  try {
    if (fake) {
      await runFakeTaskExecutionWorker({ pool, databaseUsername: "coding_agent_worker", workerId, signal: controller.signal, env: process.env });
      return;
    }
    const runner = createRealProductExecutionRunner({ config: realConfig!, pool, env: process.env });
    const zipResultBuildQueue = new PostgresZipResultBuildQueue(pool);
    const zipResultBuild = createZipResultBuilder({
      storage: new LocalProjectStorage({ rootDir: realConfig!.projectStorageRoot }),
      artifacts: new PostgresZipResultArtifactStore(pool),
      limits: {
        maxCompressedBytes: positiveInteger("PROJECT_UPLOAD_MAX_COMPRESSED_BYTES", 100 * 1024 * 1024),
        maxUncompressedBytes: positiveInteger("PROJECT_UPLOAD_MAX_UNCOMPRESSED_BYTES", 500 * 1024 * 1024),
        maxFiles: positiveInteger("PROJECT_UPLOAD_MAX_FILES", 50_000),
        maxFileBytes: positiveInteger("PROJECT_UPLOAD_MAX_FILE_BYTES", 5 * 1024 * 1024),
        maxNestedArchiveDepth: positiveInteger("PROJECT_UPLOAD_MAX_NESTED_ARCHIVE_DEPTH", 1),
      },
    });
    await runTaskExecutionWorker({ pool, databaseUsername: "coding_agent_worker", workerId, signal: controller.signal, runner, zipResultBuildQueue, zipResultBuild });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "worker failed";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});

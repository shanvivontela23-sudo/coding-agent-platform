import { createRuntimePostgresPool } from "../apps/api/src/postgres-pool.js";
import { PostgresExecutionQueue } from "../apps/worker/src/postgres-execution-queue.js";
import { createRealProductExecutionRunner } from "../apps/worker/src/real-worker.js";
import { runExecutionWorkerOnce } from "../apps/worker/src/task-execution-worker.js";
import { loadRealWorkerConfig } from "../apps/worker/src/worker-config.js";

const PAID_ACK = "I_UNDERSTAND_PAID_MODEL_AND_E2B_CHARGES";

async function main(): Promise<void> {
  if (process.env.B2_LIVE_SMOKE !== "1") throw new Error("Set B2_LIVE_SMOKE=1 to opt in to the live B2 smoke.");
  if (process.env.B2_LIVE_PAID_ACK !== PAID_ACK) {
    throw new Error(`Set B2_LIVE_PAID_ACK=${PAID_ACK} to acknowledge paid model and E2B charges.`);
  }
  if (process.env.TASK_EXECUTION_FAKE_RUNNER === "1") throw new Error("Unset TASK_EXECUTION_FAKE_RUNNER before running the paid B2 live smoke.");

  const config = loadRealWorkerConfig(process.env);
  const databaseUrl = new URL(config.databaseUrl);
  if (decodeURIComponent(databaseUrl.username) !== "coding_agent_worker") throw new Error("DATABASE_URL must use coding_agent_worker");
  const pool = createRuntimePostgresPool(config.databaseUrl, 4);
  try {
    const runner = createRealProductExecutionRunner({ config, pool, env: process.env });
    const result = await runExecutionWorkerOnce({
      queue: new PostgresExecutionQueue(pool),
      runner,
      workerId: `${config.workerId}-live-smoke`,
      leaseSeconds: 30,
    });
    if (!result.worked) throw new Error("No queued execution was available. Create and approve exactly the intended smoke task, then start implementation before running this script.");
    process.stdout.write(`${JSON.stringify({ executionId: result.executionId, status: result.status })}\n`);
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "B2 live smoke failed";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});

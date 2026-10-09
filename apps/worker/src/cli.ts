import { createRuntimePostgresPool } from "../../api/src/postgres-pool.js";
import { runFakeTaskExecutionWorker } from "./main.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  if (!process.argv.includes("--fake")) {
    throw new Error("The development worker requires --fake; real B2 execution is exercised only through explicit product wiring/live smoke.");
  }

  const databaseUrl = required("DATABASE_URL");
  const workerId = required("TASK_EXECUTION_WORKER_ID");
  const parsed = new URL(databaseUrl);
  if (decodeURIComponent(parsed.username) !== "coding_agent_worker") {
    throw new Error("DATABASE_URL must use coding_agent_worker");
  }

  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const pool = createRuntimePostgresPool(databaseUrl, 2);

  try {
    await runFakeTaskExecutionWorker({
      pool,
      databaseUsername: "coding_agent_worker",
      workerId,
      signal: controller.signal,
      env: { ...process.env, TASK_EXECUTION_FAKE_RUNNER: "1" },
    });
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

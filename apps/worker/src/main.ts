import { setTimeout as delay } from "node:timers/promises";
import { FakeCodingRunner } from "./fake-coding-runner.js";
import { PostgresExecutionQueue, type RestrictedQueryPool } from "./postgres-execution-queue.js";
import { runExecutionWorkerOnce, type CodingRunner } from "./task-execution-worker.js";

export async function runTaskExecutionWorker(options: {
  readonly pool: RestrictedQueryPool;
  readonly databaseUsername: string;
  readonly workerId: string;
  readonly signal: AbortSignal;
  readonly runner: CodingRunner;
  readonly leaseSeconds?: number;
  readonly pollIntervalMs?: number;
}): Promise<void> {
  if (options.databaseUsername !== "coding_agent_worker") throw new Error("task execution worker must connect as coding_agent_worker");
  if (!options.workerId.trim()) throw new Error("workerId is required");
  const queue = new PostgresExecutionQueue(options.pool);
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  while (!options.signal.aborted) {
    const result = await runExecutionWorkerOnce({ queue, runner: options.runner, workerId: options.workerId, ...(options.leaseSeconds === undefined ? {} : { leaseSeconds: options.leaseSeconds }) });
    if (!result.worked && !options.signal.aborted) {
      try { await delay(pollIntervalMs, undefined, { signal: options.signal }); }
      catch (error) { if (!options.signal.aborted) throw error; }
    }
  }
}

export async function runFakeTaskExecutionWorker(options: {
  readonly pool: RestrictedQueryPool;
  readonly databaseUsername: string;
  readonly workerId: string;
  readonly signal: AbortSignal;
  readonly env?: NodeJS.ProcessEnv;
  readonly leaseSeconds?: number;
  readonly pollIntervalMs?: number;
}): Promise<void> {
  const env = options.env ?? process.env;
  if (env.TASK_EXECUTION_FAKE_RUNNER !== "1") throw new Error("TASK_EXECUTION_FAKE_RUNNER=1 is required for the local fake worker");
  await runTaskExecutionWorker({
    pool: options.pool,
    databaseUsername: options.databaseUsername,
    workerId: options.workerId,
    signal: options.signal,
    runner: new FakeCodingRunner(),
    ...(options.leaseSeconds === undefined ? {} : { leaseSeconds: options.leaseSeconds }),
    ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
  });
}

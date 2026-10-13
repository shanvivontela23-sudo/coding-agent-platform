import type { ClaimedExecution, ExecutionControlState, ExecutionFinishStatus, ExecutionQueue } from "./postgres-execution-queue.js";

export type CodingRunResult = {
  readonly status: Exclude<ExecutionFinishStatus, "failed">;
  readonly failureCode?: string | null;
  readonly failureMessage?: string | null;
};

export interface CodingRunner {
  run(execution: ClaimedExecution, options: { readonly signal: AbortSignal }): Promise<CodingRunResult | void>;
}

export type RunnerFailureLog = {
  readonly event: "execution_runner_failed";
  readonly executionId: string;
  readonly workerId: string;
  readonly error: { readonly name: string; readonly message: string; readonly stack?: string };
};

const secretPatterns: readonly RegExp[] = [
  /\b(?:sk|e2b|ghs|ghp|gho|ghu|github_pat)[-_][A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+@/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

export function redactSecrets(value: string): string {
  let redacted = value;
  for (const pattern of secretPatterns) {
    redacted = redacted.replace(pattern, (match, prefix?: string) => typeof prefix === "string" && match.startsWith(prefix) ? `${prefix}[REDACTED]@` : "[REDACTED]");
  }
  return redacted;
}

export function describeRunnerFailure(executionId: string, workerId: string, error: unknown): RunnerFailureLog {
  const name = error instanceof Error ? error.name : "NonError";
  const message = redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 4_000);
  const stack = error instanceof Error && error.stack ? redactSecrets(error.stack).slice(0, 8_000) : undefined;
  return { event: "execution_runner_failed", executionId, workerId, error: stack ? { name, message, stack } : { name, message } };
}

export type WorkerOnceResult =
  | { readonly worked: false }
  | { readonly worked: true; readonly executionId: string; readonly status: ExecutionControlState };

export async function runExecutionWorkerOnce(options: {
  readonly queue: ExecutionQueue;
  readonly runner: CodingRunner;
  readonly workerId: string;
  readonly leaseSeconds?: number;
  readonly heartbeatIntervalMs?: number;
  readonly logRunnerFailure?: (entry: RunnerFailureLog) => void;
}): Promise<WorkerOnceResult> {
  const logRunnerFailure = options.logRunnerFailure ?? ((entry: RunnerFailureLog) => console.error(JSON.stringify(entry)));
  const leaseSeconds = options.leaseSeconds ?? 30;
  const execution = await options.queue.claim(options.workerId, leaseSeconds);
  if (!execution) return { worked: false };

  const controller = new AbortController();
  let controlState: ExecutionControlState = "running";
  let heartbeatBusy = false;

  const heartbeat = async (): Promise<ExecutionControlState> => {
    if (heartbeatBusy) return controlState;
    heartbeatBusy = true;
    try {
      controlState = await options.queue.heartbeat(execution.executionId, options.workerId, leaseSeconds);
      if (controlState !== "running") controller.abort();
      return controlState;
    } finally {
      heartbeatBusy = false;
    }
  };

  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? Math.max(1_000, Math.floor(leaseSeconds * 1_000 / 3));
  const heartbeatTimer = setInterval(() => { void heartbeat(); }, heartbeatIntervalMs);
  const timeoutTimer = setTimeout(() => {
    controller.abort();
    void heartbeat();
  }, execution.timeoutSeconds * 1_000);

  let runnerFailure: unknown;
  let runnerResult: CodingRunResult | void = undefined;
  try {
    runnerResult = await options.runner.run(execution, { signal: controller.signal });
  } catch (error) {
    runnerFailure = error;
    logRunnerFailure(describeRunnerFailure(execution.executionId, options.workerId, error));
  } finally {
    clearInterval(heartbeatTimer);
    clearTimeout(timeoutTimer);
  }

  const finalControl = await heartbeat();
  if (finalControl !== "running") {
    return { worked: true, executionId: execution.executionId, status: finalControl };
  }

  if (runnerFailure) {
    const interrupted = runnerFailure instanceof Error && runnerFailure.message.includes("WORKER_INTERRUPTED");
    const status = await options.queue.finish(
      execution.executionId,
      options.workerId,
      "failed",
      interrupted ? "WORKER_INTERRUPTED" : "RUNNER_FAILED",
      interrupted
        ? "Implementation worker stopped during paid coding. Start a new attempt to retry safely."
        : "Implementation failed before delivery.",
    );
    return { worked: true, executionId: execution.executionId, status };
  }

  const requestedStatus = runnerResult?.status ?? "succeeded";
  const status = await options.queue.finish(
    execution.executionId,
    options.workerId,
    requestedStatus,
    runnerResult?.failureCode ?? null,
    runnerResult?.failureMessage ?? null,
  );
  return { worked: true, executionId: execution.executionId, status };
}

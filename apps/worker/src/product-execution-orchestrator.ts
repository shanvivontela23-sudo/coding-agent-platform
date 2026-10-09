import type { SandboxProvider } from "../../../evals/src/sandbox/types.js";
import type { ClaimedExecution } from "./postgres-execution-queue.js";
import type { CodingRunResult, CodingRunner } from "./task-execution-worker.js";
import type { ExecutionSourceProvider } from "./execution-source.js";
import type { ExecutionStore } from "./execution-store.js";
import type { ProductCodingRunner } from "./product-coding-runner.js";
import type { PatchSafetyLimits } from "./patch-safety.js";

export class ProductExecutionOrchestrator implements CodingRunner {
  constructor(_options: {
    readonly store: ExecutionStore;
    readonly sourceProvider: ExecutionSourceProvider;
    readonly codingRunner: ProductCodingRunner;
    readonly verificationSandboxProvider: SandboxProvider;
    readonly patchLimits: PatchSafetyLimits;
  }) {}

  async run(_execution: ClaimedExecution, _options: { readonly signal: AbortSignal }): Promise<CodingRunResult> {
    throw new Error("B2 product execution orchestrator is not implemented");
  }
}

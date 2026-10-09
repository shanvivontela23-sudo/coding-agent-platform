import type { HarnessRunner } from "../../../evals/src/harness/types.js";
import type { SandboxProvider } from "../../../evals/src/sandbox/types.js";
import type { PreparedExecutionSource } from "./execution-source.js";

export type ProductCodingResult = {
  readonly patch: string;
  readonly reproductionCommand: string | null;
  readonly costUsd: number;
  readonly summary: string;
};

export type ExecutionModelRoute = {
  readonly gatewayUrl: string;
  readonly runToken: string;
  readonly model: string;
};

export class ProductCodingRunner {
  constructor(_options: {
    readonly sandboxProvider: SandboxProvider;
    readonly harnessRunner: HarnessRunner;
    readonly route: ExecutionModelRoute;
    readonly maxTurns?: number;
    readonly timeoutMs?: number;
    readonly readCostUsd?: () => Promise<number>;
  }) {}

  async run(_taskId: string, _source: PreparedExecutionSource): Promise<ProductCodingResult> {
    throw new Error("B2 product coding runner is not implemented");
  }
}

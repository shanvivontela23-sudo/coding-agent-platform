import type { SandboxProvider } from "../../../evals/src/sandbox/types.js";
import type { PreparedExecutionSource } from "./execution-source.js";

export type VerificationCheck = {
  readonly name: "test" | "build";
  readonly command: string;
  readonly baselineExitCode: number;
  readonly patchedExitCode: number;
  readonly status: "passed" | "failed" | "pre_existing" | "skipped";
};

export type ReproduceProof = {
  readonly command: string | null;
  readonly baselineExitCode: number | null;
  readonly patchedExitCode: number | null;
  readonly reproduced: boolean;
};

export type VerificationResult = {
  readonly checks: readonly VerificationCheck[];
  readonly hasNewFailures: boolean;
  readonly reproduce: ReproduceProof;
};

export async function verifyExecution(_options: {
  readonly sandboxProvider: SandboxProvider;
  readonly taskId: string;
  readonly source: PreparedExecutionSource;
  readonly patch: string;
  readonly reproductionCommand: string | null;
  readonly timeoutMs?: number;
}): Promise<VerificationResult> {
  throw new Error("B2 verification is not implemented");
}

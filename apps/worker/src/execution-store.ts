import type { ClaimedExecution } from "./postgres-execution-queue.js";
import type { PatchSafetyResult } from "./patch-safety.js";
import type { VerificationResult } from "./verification.js";

export type ExecutionProgress = {
  readonly sourcePreparedAt: string | null;
  readonly codingStartedAt: string | null;
  readonly codingFinishedAt: string | null;
  readonly patchExportedAt: string | null;
  readonly verifiedAt: string | null;
  readonly resultPatch: string | null;
  readonly resultMetadata: Readonly<Record<string, unknown>>;
};

export interface ExecutionStore {
  getProgress(execution: ClaimedExecution): Promise<ExecutionProgress>;
  markSourcePrepared(execution: ClaimedExecution): Promise<void>;
  markCodingStarted(execution: ClaimedExecution): Promise<void>;
  saveSafeCodingOutput(execution: ClaimedExecution, input: {
    readonly patch: string;
    readonly safety: PatchSafetyResult;
    readonly reproductionCommand: string | null;
    readonly codingSummary: string;
    readonly costUsd: number;
  }): Promise<void>;
  saveVerification(execution: ClaimedExecution, input: {
    readonly verification: VerificationResult;
    readonly changeDocument: string;
    readonly costUsd: number;
  }): Promise<void>;
}

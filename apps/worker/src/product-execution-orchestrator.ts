import type { SandboxProvider } from "../../../evals/src/sandbox/types.js";
import { buildChangeDocument } from "./change-document.js";
import type { ClaimedExecution } from "./postgres-execution-queue.js";
import type { CodingRunResult, CodingRunner } from "./task-execution-worker.js";
import type { ExecutionSourceProvider } from "./execution-source.js";
import type { ExecutionStore } from "./execution-store.js";
import { CodingRunError, type ProductCodingRunner } from "./product-coding-runner.js";
import { inspectPatchSafety, type PatchSafetyLimits } from "./patch-safety.js";
import { verifyExecution, type VerificationResult } from "./verification.js";

type Verify = (options: Parameters<typeof verifyExecution>[0]) => Promise<VerificationResult>;
type OrchestratorOptions = {
  readonly store: ExecutionStore;
  readonly sourceProvider: ExecutionSourceProvider;
  readonly codingRunner: ProductCodingRunner;
  readonly verificationSandboxProvider: SandboxProvider;
  readonly patchLimits: PatchSafetyLimits;
  readonly verify?: Verify;
  readonly nowMs?: () => number;
};

function metadataString(value: unknown): string | null { return typeof value === "string" ? value : null; }
function metadataCost(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null; }
function abortError(): Error { return new Error("execution aborted"); }

export class ProductExecutionOrchestrator implements CodingRunner {
  private readonly options: OrchestratorOptions;
  constructor(options: OrchestratorOptions) { this.options = options; }

  async run(execution: ClaimedExecution, runOptions: { readonly signal: AbortSignal }): Promise<CodingRunResult> {
    const now = this.options.nowMs ?? Date.now;
    const totalMs = execution.timeoutSeconds * 1_000;
    if (!Number.isSafeInteger(totalMs) || totalMs <= 0) throw new Error("execution timeout must be positive");
    const startedAt = now();
    const deadline = startedAt + totalMs;
    const codingBudgetMs = Math.max(1, Math.floor(totalMs * 0.6));
    const verificationBudgetMs = Math.max(1, totalMs - codingBudgetMs);
    const remaining = () => Math.max(0, deadline - now());
    if (runOptions.signal.aborted) throw abortError();

    let progress = await this.options.store.getProgress(execution);
    if (progress.codingStartedAt && !progress.codingFinishedAt) {
      throw new Error("WORKER_INTERRUPTED: paid coding began but did not finish; refusing automatic rerun");
    }

    const source = await this.options.sourceProvider.prepare({
      organizationId: execution.organizationId,
      taskId: execution.taskId,
      projectId: execution.projectId,
      sourceCommitSha: execution.sourceCommitSha,
      sourceVersionId: execution.sourceVersionId,
    });
    if (!progress.sourcePreparedAt) {
      await this.options.store.markSourcePrepared(execution);
      progress = await this.options.store.getProgress(execution);
    }

    let patch = progress.resultPatch;
    let reproductionCommand = metadataString(progress.resultMetadata.reproductionCommand);
    let codingSummary = metadataString(progress.resultMetadata.codingSummary) ?? "Implementation completed.";
    let costUsd = metadataCost(progress.resultMetadata.costUsd);
    let safety;

    if (!progress.codingFinishedAt || !progress.patchExportedAt || !patch) {
      if (runOptions.signal.aborted) throw abortError();
      const codingTimeoutMs = Math.min(codingBudgetMs, remaining());
      if (codingTimeoutMs <= 0) throw new Error("execution timeout expired before coding");
      await this.options.store.markCodingStarted(execution);
      let coding;
      try {
        coding = await this.options.codingRunner.run(execution.executionId, source, { signal: runOptions.signal, timeoutMs: codingTimeoutMs });
      } catch (error) {
        if (error instanceof CodingRunError) await this.options.store.saveCost(execution, error.costUsd);
        else await this.options.store.saveCost(execution, null);
        throw error;
      }
      costUsd = coding.costUsd;
      await this.options.store.saveCost(execution, costUsd);
      if (runOptions.signal.aborted) throw abortError();
      safety = inspectPatchSafety(coding.patch, this.options.patchLimits);
      patch = coding.patch;
      reproductionCommand = coding.reproductionCommand;
      codingSummary = coding.summary;
      await this.options.store.saveSafeCodingOutput(execution, { patch, safety, reproductionCommand, codingSummary, costUsd });
    } else {
      safety = inspectPatchSafety(patch, this.options.patchLimits);
    }

    if (runOptions.signal.aborted) throw abortError();
    const verificationTimeoutMs = Math.min(verificationBudgetMs, remaining());
    if (verificationTimeoutMs <= 0) throw new Error("execution timeout expired before verification");
    const verify = this.options.verify ?? verifyExecution;
    const verification = await verify({
      sandboxProvider: this.options.verificationSandboxProvider,
      taskId: execution.taskId,
      source,
      patch,
      reproductionCommand,
      timeoutMs: verificationTimeoutMs,
      signal: runOptions.signal,
    });

    const bugTask = source.jobType === "bug_fix";
    const status: CodingRunResult["status"] = verification.hasNewFailures
      ? "verification_failed"
      : bugTask && !verification.reproduce.reproduced
        ? "fix_not_reproduced"
        : "succeeded";
    const unverifiedPreExisting = verification.checks.some((check) => check.status === "pre_existing_unverified");
    const reproduceProof = verification.reproduce.reproduced
      ? `Fail-before/pass-after proof: ${verification.reproduce.command ?? "reproduction check"}. Baseline classification: ${verification.reproduce.baselineClassification}; patched classification: ${verification.reproduce.patchedClassification}.`
      : bugTask
        ? `Fix not reproduced: ${verification.reproduce.reason ?? "no valid fail-before/pass-after proof was produced."}`
        : "Not required for this task type.";
    const reviewFocus = unverifiedPreExisting
      ? `${source.reviewFocus} Pre-existing failures could not be compared by test name; those checks remain unverified.`
      : source.reviewFocus;
    const changeDocument = buildChangeDocument({
      asked: source.requirement,
      changed: codingSummary,
      files: safety.files,
      checks: verification.checks.map((check) => ({ name: check.name, status: check.status })),
      reproduceProof,
      costUsd,
      reviewFocus,
    });
    await this.options.store.saveVerification(execution, { verification, changeDocument, costUsd });

    if (status === "verification_failed") {
      return { status, failureCode: "VERIFICATION_FAILED", failureMessage: "New failures were found on the clean patched copy." };
    }
    if (status === "fix_not_reproduced") {
      return { status, failureCode: "FIX_NOT_REPRODUCED", failureMessage: "The patch is available for review, but the reported bug was not proven with a valid fail-before/pass-after test." };
    }
    return { status };
  }
}

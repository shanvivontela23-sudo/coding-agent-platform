import type { SandboxProvider } from "../../../evals/src/sandbox/types.js";
import { buildChangeDocument } from "./change-document.js";
import type { ClaimedExecution } from "./postgres-execution-queue.js";
import type { CodingRunResult, CodingRunner } from "./task-execution-worker.js";
import type { ExecutionSourceProvider } from "./execution-source.js";
import type { ExecutionStore } from "./execution-store.js";
import type { ProductCodingRunner } from "./product-coding-runner.js";
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
};

function metadataString(value: unknown): string | null { return typeof value === "string" ? value : null; }
function metadataNumber(value: unknown): number { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0; }

export class ProductExecutionOrchestrator implements CodingRunner {
  private readonly options: OrchestratorOptions;
  constructor(options: OrchestratorOptions) { this.options = options; }

  async run(execution: ClaimedExecution, runOptions: { readonly signal: AbortSignal }): Promise<CodingRunResult> {
    let progress = await this.options.store.getProgress(execution);
    if (progress.codingStartedAt && !progress.codingFinishedAt) {
      throw new Error("WORKER_INTERRUPTED: paid coding began but did not finish; refusing automatic rerun");
    }
    if (runOptions.signal.aborted) throw new Error("execution aborted");

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
    let costUsd = metadataNumber(progress.resultMetadata.costUsd);
    let safety;

    if (!progress.codingFinishedAt || !progress.patchExportedAt || !patch) {
      if (runOptions.signal.aborted) throw new Error("execution aborted");
      await this.options.store.markCodingStarted(execution);
      const coding = await this.options.codingRunner.run(execution.executionId, source);
      if (runOptions.signal.aborted) throw new Error("execution aborted");
      safety = inspectPatchSafety(coding.patch, this.options.patchLimits);
      patch = coding.patch;
      reproductionCommand = coding.reproductionCommand;
      codingSummary = coding.summary;
      costUsd = coding.costUsd;
      await this.options.store.saveSafeCodingOutput(execution, {
        patch,
        safety,
        reproductionCommand,
        codingSummary,
        costUsd,
      });
    } else {
      safety = inspectPatchSafety(patch, this.options.patchLimits);
    }

    if (runOptions.signal.aborted) throw new Error("execution aborted");
    const verify = this.options.verify ?? verifyExecution;
    const verification = await verify({
      sandboxProvider: this.options.verificationSandboxProvider,
      taskId: execution.taskId,
      source,
      patch,
      reproductionCommand,
    });

    const bugTask = source.jobType === "bug_fix";
    const status: CodingRunResult["status"] = verification.hasNewFailures
      ? "verification_failed"
      : bugTask && !verification.reproduce.reproduced
        ? "fix_not_reproduced"
        : "succeeded";
    const reproduceProof = verification.reproduce.reproduced
      ? `Fail-before/pass-after proof: ${verification.reproduce.command ?? "reproduction check"}.`
      : bugTask
        ? "Fix not reproduced: no valid fail-before/pass-after proof was produced."
        : "Not required for this task type.";
    const changeDocument = buildChangeDocument({
      asked: source.requirement,
      changed: codingSummary,
      files: safety.files,
      checks: verification.checks.map((check) => ({ name: check.name, status: check.status })),
      reproduceProof,
      costUsd,
      reviewFocus: source.reviewFocus,
    });
    await this.options.store.saveVerification(execution, { verification, changeDocument, costUsd });

    if (status === "verification_failed") {
      return { status, failureCode: "VERIFICATION_FAILED", failureMessage: "New failures were found on the clean patched copy." };
    }
    if (status === "fix_not_reproduced") {
      return { status, failureCode: "FIX_NOT_REPRODUCED", failureMessage: "The patch is available for review, but the reported bug was not proven with a fail-before/pass-after test." };
    }
    return { status };
  }
}

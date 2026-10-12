import { describe, expect, it } from "vitest";
import type { SandboxProvider } from "../../../evals/src/sandbox/types.js";
import type { ExecutionSourceProvider, PreparedExecutionSource } from "../src/execution-source.js";
import type { ExecutionProgress, ExecutionStore } from "../src/execution-store.js";
import type { ClaimedExecution } from "../src/postgres-execution-queue.js";
import type { ProductCodingRunner } from "../src/product-coding-runner.js";
import { ProductExecutionOrchestrator } from "../src/product-execution-orchestrator.js";
import type { VerificationResult } from "../src/verification.js";

const execution: ClaimedExecution = {
  executionId: "50000000-0000-4000-8000-000000000301",
  organizationId: "00000000-0000-4000-8000-000000000301",
  taskId: "40000000-0000-4000-8000-000000000301",
  projectId: "20000000-0000-4000-8000-000000000301",
  attempt: 1,
  sourceCommitSha: "a".repeat(40),
  sourceVersionId: null,
  budgetUsd: 1,
  timeoutSeconds: 100,
};

const patch = "diff --git a/src/app.py b/src/app.py\n--- a/src/app.py\n+++ b/src/app.py\n@@ -1 +1 @@\n-old\n+new\n";

function source(commands: PreparedExecutionSource["commands"]): PreparedExecutionSource {
  return {
    repository: { pinnedCommit: "a".repeat(40), archiveSha256: "b".repeat(64), archive: new Uint8Array([1]) },
    jobType: "feature",
    requirement: "Change behavior",
    plan: "Update implementation",
    commands,
    reviewFocus: "review behavior",
  };
}

function progress(): ExecutionProgress {
  return { sourcePreparedAt: null, codingStartedAt: null, codingFinishedAt: null, patchExportedAt: null, verifiedAt: null, resultPatch: null, resultMetadata: {} };
}

function store(): ExecutionStore & { changeDocument: string | null } {
  let state = progress();
  return {
    changeDocument: null,
    async getProgress() { return state; },
    async markSourcePrepared() { state = { ...state, sourcePreparedAt: "now" }; },
    async markCodingStarted() { state = { ...state, codingStartedAt: "now" }; },
    async saveCost() {},
    async saveSafeCodingOutput(_execution, input) { state = { ...state, codingFinishedAt: "now", patchExportedAt: "now", resultPatch: input.patch, resultMetadata: { codingSummary: input.codingSummary, reproductionCommand: input.reproductionCommand, costUsd: input.costUsd } }; },
    async saveVerification(_execution, input) { this.changeDocument = input.changeDocument; state = { ...state, verifiedAt: "now" }; },
  };
}

function runner(): ProductCodingRunner {
  return { async run() { return { patch, reproductionCommand: null, costUsd: 0.2, summary: "changed" }; } } as unknown as ProductCodingRunner;
}

function provider(prepared: PreparedExecutionSource): ExecutionSourceProvider {
  return { async prepare() { return prepared; } };
}

const verificationSandboxProvider = {} as SandboxProvider;

describe("verification completeness", () => {
  it("returns verification_incomplete for a Python project with no install command and no passing baseline", async () => {
    const durable = store();
    const verification: VerificationResult = {
      checks: [{ name: "test", command: "pytest", baselineExitCode: 1, patchedExitCode: 1, status: "pre_existing_unverified", baselineFailingTests: [], patchedFailingTests: [] }],
      hasNewFailures: false,
      complete: false,
      incompleteReason: "No test or build command completed successfully on the approved baseline.",
      reproduce: { command: null, baselineExitCode: null, patchedExitCode: null, baselineOutput: "", patchedOutput: "", baselineClassification: "not_run", patchedClassification: "not_run", reproduced: false, reason: null },
    };
    const orchestrator = new ProductExecutionOrchestrator({
      store: durable,
      sourceProvider: provider(source({ install: null, test: "pytest", build: null })),
      codingRunner: runner(),
      verificationSandboxProvider,
      patchLimits: { maxFiles: 10, maxBytes: 100_000 },
      verify: async () => verification,
    });

    await expect(orchestrator.run(execution, { signal: new AbortController().signal })).resolves.toMatchObject({
      status: "verification_incomplete",
      failureCode: "VERIFICATION_INCOMPLETE",
    });
    expect(durable.changeDocument).toContain("Verification incomplete");
    expect(durable.changeDocument).toContain("No test or build command completed successfully on the approved baseline.");
  });

  it("still succeeds for a JavaScript project with a successful baseline", async () => {
    const verification: VerificationResult = {
      checks: [{ name: "test", command: "pnpm test", baselineExitCode: 0, patchedExitCode: 0, status: "passed", baselineFailingTests: [], patchedFailingTests: [] }],
      hasNewFailures: false,
      complete: true,
      incompleteReason: null,
      reproduce: { command: null, baselineExitCode: null, patchedExitCode: null, baselineOutput: "", patchedOutput: "", baselineClassification: "not_run", patchedClassification: "not_run", reproduced: false, reason: null },
    };
    const orchestrator = new ProductExecutionOrchestrator({
      store: store(),
      sourceProvider: provider(source({ install: "pnpm install --frozen-lockfile", test: "pnpm test", build: null })),
      codingRunner: runner(),
      verificationSandboxProvider,
      patchLimits: { maxFiles: 10, maxBytes: 100_000 },
      verify: async () => verification,
    });

    await expect(orchestrator.run(execution, { signal: new AbortController().signal })).resolves.toMatchObject({ status: "succeeded" });
  });
});

import { describe, expect, it, vi } from "vitest";
import type { SandboxProvider } from "../../../evals/src/sandbox/types.js";
import type { ExecutionSourceProvider, PreparedExecutionSource } from "../src/execution-source.js";
import type { ExecutionProgress, ExecutionStore } from "../src/execution-store.js";
import type { ProductCodingResult, ProductCodingRunner } from "../src/product-coding-runner.js";
import { ProductExecutionOrchestrator } from "../src/product-execution-orchestrator.js";
import type { VerificationResult } from "../src/verification.js";
import type { ClaimedExecution } from "../src/postgres-execution-queue.js";

const execution: ClaimedExecution = {
  executionId: "50000000-0000-4000-8000-000000000251",
  organizationId: "00000000-0000-4000-8000-000000000251",
  taskId: "40000000-0000-4000-8000-000000000251",
  projectId: "20000000-0000-4000-8000-000000000251",
  attempt: 1,
  sourceCommitSha: "a".repeat(40),
  sourceVersionId: null,
  budgetUsd: 2,
  timeoutSeconds: 600,
};

const source: PreparedExecutionSource = {
  repository: { pinnedCommit: "a".repeat(40), archiveSha256: "b".repeat(64), archive: new Uint8Array([1]) },
  jobType: "bug_fix",
  requirement: "Retry should recover",
  plan: "Fix state and add regression coverage",
  commands: { install: null, test: "pnpm test", build: null },
  reviewFocus: "retry state",
};

const patch = "diff --git a/src/retry.test.ts b/src/retry.test.ts\n--- a/src/retry.test.ts\n+++ b/src/retry.test.ts\n@@ -1 +1 @@\n-old\n+new\n";
const coding: ProductCodingResult = { patch, reproductionCommand: "pnpm test src/retry.test.ts", costUsd: 0.25, summary: "coded" };
const verification: VerificationResult = {
  checks: [{ name: "test", command: "pnpm test", baselineExitCode: 0, patchedExitCode: 0, status: "passed" }],
  hasNewFailures: false,
  reproduce: { command: "pnpm test src/retry.test.ts", baselineExitCode: 1, patchedExitCode: 0, reproduced: true },
};

function progress(overrides: Partial<ExecutionProgress> = {}): ExecutionProgress {
  return {
    sourcePreparedAt: null,
    codingStartedAt: null,
    codingFinishedAt: null,
    patchExportedAt: null,
    verifiedAt: null,
    resultPatch: null,
    resultMetadata: {},
    ...overrides,
  };
}

function store(initial: ExecutionProgress): ExecutionStore & { calls: string[] } {
  const state = { value: initial };
  const calls: string[] = [];
  return {
    calls,
    async getProgress() { return state.value; },
    async markSourcePrepared() { calls.push("source_prepared"); state.value = { ...state.value, sourcePreparedAt: "now" }; },
    async markCodingStarted() { calls.push("coding_started"); state.value = { ...state.value, codingStartedAt: "now" }; },
    async saveSafeCodingOutput(_execution, input) {
      calls.push("coding_finished", "patch_exported");
      state.value = { ...state.value, codingFinishedAt: "now", patchExportedAt: "now", resultPatch: input.patch, resultMetadata: { reproductionCommand: input.reproductionCommand, codingSummary: input.codingSummary, costUsd: input.costUsd } };
    },
    async saveVerification() { calls.push("verified"); state.value = { ...state.value, verifiedAt: "now" }; },
  };
}

function sourceProvider(): ExecutionSourceProvider {
  return { async prepare() { return source; } };
}

function codingRunner(spy = vi.fn(async () => coding)): ProductCodingRunner {
  return { run: spy } as unknown as ProductCodingRunner;
}

const verificationProvider = {} as SandboxProvider;

describe("ProductExecutionOrchestrator", () => {
  it("persists paid-step boundaries and returns succeeded after independent proof", async () => {
    const durable = store(progress());
    const coder = vi.fn(async () => coding);
    const orchestrator = new ProductExecutionOrchestrator({
      store: durable,
      sourceProvider: sourceProvider(),
      codingRunner: codingRunner(coder),
      verificationSandboxProvider: verificationProvider,
      patchLimits: { maxFiles: 10, maxBytes: 100_000 },
      verify: async () => verification,
    });
    await expect(orchestrator.run(execution, { signal: new AbortController().signal })).resolves.toMatchObject({ status: "succeeded" });
    expect(coder).toHaveBeenCalledTimes(1);
    expect(durable.calls).toEqual(["source_prepared", "coding_started", "coding_finished", "patch_exported", "verified"]);
  });

  it("never automatically re-enters coding after coding_started without coding_finished", async () => {
    const coder = vi.fn(async () => coding);
    const orchestrator = new ProductExecutionOrchestrator({
      store: store(progress({ sourcePreparedAt: "earlier", codingStartedAt: "earlier" })),
      sourceProvider: sourceProvider(),
      codingRunner: codingRunner(coder),
      verificationSandboxProvider: verificationProvider,
      patchLimits: { maxFiles: 10, maxBytes: 100_000 },
      verify: async () => verification,
    });
    await expect(orchestrator.run(execution, { signal: new AbortController().signal })).rejects.toThrow(/WORKER_INTERRUPTED/);
    expect(coder).not.toHaveBeenCalled();
  });

  it("resumes model-free verification from a safely persisted exported patch", async () => {
    const coder = vi.fn(async () => coding);
    const durable = store(progress({
      sourcePreparedAt: "earlier",
      codingStartedAt: "earlier",
      codingFinishedAt: "earlier",
      patchExportedAt: "earlier",
      resultPatch: patch,
      resultMetadata: { reproductionCommand: "pnpm test src/retry.test.ts", codingSummary: "coded", costUsd: 0.25 },
    }));
    const orchestrator = new ProductExecutionOrchestrator({
      store: durable,
      sourceProvider: sourceProvider(),
      codingRunner: codingRunner(coder),
      verificationSandboxProvider: verificationProvider,
      patchLimits: { maxFiles: 10, maxBytes: 100_000 },
      verify: async () => verification,
    });
    await expect(orchestrator.run(execution, { signal: new AbortController().signal })).resolves.toMatchObject({ status: "succeeded" });
    expect(coder).not.toHaveBeenCalled();
    expect(durable.calls).toEqual(["verified"]);
  });

  it("returns verification_failed for new failures and fix_not_reproduced for unproven bug fixes", async () => {
    const common = { store: store(progress()), sourceProvider: sourceProvider(), codingRunner: codingRunner(), verificationSandboxProvider: verificationProvider, patchLimits: { maxFiles: 10, maxBytes: 100_000 } };
    const verificationFailed = new ProductExecutionOrchestrator({ ...common, verify: async () => ({ ...verification, hasNewFailures: true }) });
    await expect(verificationFailed.run(execution, { signal: new AbortController().signal })).resolves.toMatchObject({ status: "verification_failed" });

    const unproven = new ProductExecutionOrchestrator({ ...common, store: store(progress()), verify: async () => ({ ...verification, reproduce: { command: null, baselineExitCode: null, patchedExitCode: null, reproduced: false } }) });
    await expect(unproven.run(execution, { signal: new AbortController().signal })).resolves.toMatchObject({ status: "fix_not_reproduced" });
  });
});

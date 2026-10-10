import type { HarnessRunner } from "../../../evals/src/harness/types.js";
import type { SandboxProvider } from "../../../evals/src/sandbox/types.js";
import type { PreparedExecutionSource } from "./execution-source.js";
import { testPathsFromPatch } from "./patch-parser.js";

export type ProductCodingResult = {
  readonly patch: string;
  readonly reproductionCommand: string | null;
  readonly costUsd: number;
  readonly summary: string;
};

export class CodingRunError extends Error {
  readonly costUsd: number | null;
  constructor(message: string, costUsd: number | null, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "CodingRunError";
    this.costUsd = costUsd;
  }
}

export type ExecutionModelRoute = {
  readonly gatewayUrl: string;
  readonly runToken: string;
  readonly model: string;
};

type Options = {
  readonly sandboxProvider: SandboxProvider;
  readonly harnessRunner: HarnessRunner;
  readonly route: ExecutionModelRoute;
  readonly maxTurns?: number;
  readonly readCostUsd: () => Promise<number>;
};

function shellArg(value: string): string {
  return /^[A-Za-z0-9_./:@+-]+$/.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`;
}

function reproductionCommand(source: PreparedExecutionSource, patch: string): string | null {
  if (source.jobType !== "bug_fix" || !source.commands.test) return null;
  const testPath = testPathsFromPatch(patch).find((path) => path.length > 0);
  return testPath ? `${source.commands.test} ${shellArg(testPath)}` : null;
}

function abortError(stageTimedOut: boolean): Error {
  return new Error(stageTimedOut ? "coding stage timed out" : "execution aborted");
}

export class ProductCodingRunner {
  private readonly options: Options;
  constructor(options: Options) { this.options = options; }

  private async reconciledCost(): Promise<number | null> {
    try {
      const costUsd = await this.options.readCostUsd();
      if (!Number.isFinite(costUsd) || costUsd < 0) throw new Error("execution cost must be non-negative");
      return costUsd;
    } catch {
      return null;
    }
  }

  async run(taskId: string, source: PreparedExecutionSource, runOptions: { readonly signal: AbortSignal; readonly timeoutMs: number }): Promise<ProductCodingResult> {
    if (!Number.isFinite(runOptions.timeoutMs) || runOptions.timeoutMs <= 0) throw new Error("coding timeout must be positive");
    if (runOptions.signal.aborted) throw new CodingRunError("execution aborted", null);

    const deadline = Date.now() + runOptions.timeoutMs;
    const stageController = new AbortController();
    let stageTimedOut = false;
    const onOuterAbort = () => stageController.abort();
    runOptions.signal.addEventListener("abort", onOuterAbort, { once: true });
    const stageTimer = setTimeout(() => { stageTimedOut = true; stageController.abort(); }, runOptions.timeoutMs);
    stageTimer.unref?.();
    const signal = stageController.signal;
    const remainingMs = () => Math.max(1, deadline - Date.now());
    const assertActive = () => { if (signal.aborted) throw abortError(stageTimedOut); };

    let session: Awaited<ReturnType<SandboxProvider["create"]>> | null = null;
    let destroyed = false;
    let phase: "locked" | "dependency-setup" | "coding" | "testing" | "offline" = "locked";
    const destroy = async () => { if (session && !destroyed) { destroyed = true; await session.destroy(); } };
    const onStageAbort = () => { void destroy(); };
    signal.addEventListener("abort", onStageAbort, { once: true });

    try {
      assertActive();
      session = await this.options.sandboxProvider.create({ taskId, repository: source.repository, gatewayUrl: this.options.route.gatewayUrl, timeoutMs: remainingMs() });
      assertActive();
      await session.setNetworkPhase("dependency-setup");
      phase = "dependency-setup";
      assertActive();
      if (source.commands.install) {
        const install = await session.exec({ command: source.commands.install, cwd: session.workspacePath, timeoutMs: remainingMs() });
        assertActive();
        if (install.exitCode !== 0) throw new Error("coding dependency setup failed");
      }
      await session.setNetworkPhase("coding");
      phase = "coding";
      assertActive();

      const harnessPromise = this.options.harnessRunner.run(session, {
        ticketText: `${source.requirement}\n\nApproved plan:\n${source.plan}\n\nFor bug fixes, add a focused regression test that fails before the fix and passes after it.`,
        model: this.options.route.model,
        gatewayUrl: this.options.route.gatewayUrl,
        runToken: this.options.route.runToken,
        maxTurns: this.options.maxTurns ?? 24,
        timeoutMs: remainingMs(),
      });
      let rejectAbort: ((error: Error) => void) | null = null;
      const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
      const abortHarness = () => { void destroy(); rejectAbort?.(abortError(stageTimedOut)); };
      signal.addEventListener("abort", abortHarness, { once: true });
      if (signal.aborted) abortHarness();
      let outcome;
      try {
        outcome = await Promise.race([harnessPromise, aborted]);
      } catch (error) {
        void harnessPromise.catch(() => undefined);
        const costUsd = await this.reconciledCost();
        throw new CodingRunError(error instanceof Error ? error.message : "coding harness failed", costUsd, { cause: error });
      } finally {
        signal.removeEventListener("abort", abortHarness);
      }
      assertActive();
      const costUsd = await this.reconciledCost();
      if (costUsd === null) throw new CodingRunError("execution cost reconciliation failed", null);
      if (outcome.status !== "completed") throw new CodingRunError(`coding harness ended with ${outcome.status}${outcome.limit ? ` (${outcome.limit})` : ""}`, costUsd);
      return { patch: outcome.patch.patch, reproductionCommand: reproductionCommand(source, outcome.patch.patch), costUsd, summary: `${this.options.harnessRunner.name} completed in ${outcome.turnsUsed} turns.` };
    } catch (error) {
      if (error instanceof CodingRunError) throw error;
      const costUsd = await this.reconciledCost();
      throw new CodingRunError(error instanceof Error ? error.message : "coding failed", costUsd, { cause: error });
    } finally {
      clearTimeout(stageTimer);
      runOptions.signal.removeEventListener("abort", onOuterAbort);
      signal.removeEventListener("abort", onStageAbort);
      if (session && !destroyed && !signal.aborted) {
        try {
          if (phase === "coding") await session.setNetworkPhase("testing");
          else if (phase === "dependency-setup") await session.setNetworkPhase("offline");
        } catch {
          // The sandbox is destroyed below; phase cleanup failure must not keep spend alive.
        }
      }
      await destroy();
    }
  }
}

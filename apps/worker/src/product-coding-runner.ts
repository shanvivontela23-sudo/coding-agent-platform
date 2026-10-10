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

function abortError(): Error { return new Error("execution aborted"); }
function assertNotAborted(signal: AbortSignal): void { if (signal.aborted) throw abortError(); }

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
    assertNotAborted(runOptions.signal);
    const session = await this.options.sandboxProvider.create({ taskId, repository: source.repository, gatewayUrl: this.options.route.gatewayUrl, timeoutMs: runOptions.timeoutMs });
    let destroyed = false;
    let phase: "locked" | "dependency-setup" | "coding" | "testing" | "offline" = "locked";
    const destroy = async () => { if (!destroyed) { destroyed = true; await session.destroy(); } };
    const onAbort = () => { void destroy(); };
    runOptions.signal.addEventListener("abort", onAbort, { once: true });

    try {
      assertNotAborted(runOptions.signal);
      await session.setNetworkPhase("dependency-setup");
      phase = "dependency-setup";
      assertNotAborted(runOptions.signal);
      if (source.commands.install) {
        const install = await session.exec({ command: source.commands.install, cwd: session.workspacePath, timeoutMs: runOptions.timeoutMs });
        assertNotAborted(runOptions.signal);
        if (install.exitCode !== 0) throw new Error("coding dependency setup failed");
      }
      await session.setNetworkPhase("coding");
      phase = "coding";
      assertNotAborted(runOptions.signal);

      const harnessPromise = this.options.harnessRunner.run(session, {
        ticketText: `${source.requirement}\n\nApproved plan:\n${source.plan}\n\nFor bug fixes, add a focused regression test that fails before the fix and passes after it.`,
        model: this.options.route.model,
        gatewayUrl: this.options.route.gatewayUrl,
        runToken: this.options.route.runToken,
        maxTurns: this.options.maxTurns ?? 24,
        timeoutMs: runOptions.timeoutMs,
      });
      let rejectAbort: ((error: Error) => void) | null = null;
      const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
      const abortHarness = () => { void destroy(); rejectAbort?.(abortError()); };
      runOptions.signal.addEventListener("abort", abortHarness, { once: true });
      if (runOptions.signal.aborted) abortHarness();
      let outcome;
      try {
        outcome = await Promise.race([harnessPromise, aborted]);
      } catch (error) {
        void harnessPromise.catch(() => undefined);
        const costUsd = await this.reconciledCost();
        throw new CodingRunError(error instanceof Error ? error.message : "coding harness failed", costUsd, { cause: error });
      } finally {
        runOptions.signal.removeEventListener("abort", abortHarness);
      }
      assertNotAborted(runOptions.signal);
      const costUsd = await this.reconciledCost();
      if (costUsd === null) throw new CodingRunError("execution cost reconciliation failed", null);
      if (outcome.status !== "completed") throw new CodingRunError(`coding harness ended with ${outcome.status}${outcome.limit ? ` (${outcome.limit})` : ""}`, costUsd);
      return { patch: outcome.patch.patch, reproductionCommand: reproductionCommand(source, outcome.patch.patch), costUsd, summary: `${this.options.harnessRunner.name} completed in ${outcome.turnsUsed} turns.` };
    } catch (error) {
      if (error instanceof CodingRunError) throw error;
      const costUsd = await this.reconciledCost();
      throw new CodingRunError(error instanceof Error ? error.message : "coding failed", costUsd, { cause: error });
    } finally {
      runOptions.signal.removeEventListener("abort", onAbort);
      if (!destroyed && !runOptions.signal.aborted) {
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

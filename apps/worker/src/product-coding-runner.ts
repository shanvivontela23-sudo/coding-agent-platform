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

type Options = {
  readonly sandboxProvider: SandboxProvider;
  readonly harnessRunner: HarnessRunner;
  readonly route: ExecutionModelRoute;
  readonly maxTurns?: number;
  readonly timeoutMs?: number;
  readonly readCostUsd?: () => Promise<number>;
};

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function reproductionCommand(source: PreparedExecutionSource, patch: string): string | null {
  if (source.jobType !== "bug_fix" || !source.commands.test) return null;
  const paths = [...patch.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)].map((match) => match[2]!);
  const testPath = paths.find((path) => /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:test|spec)\.[^/]+$/i.test(path));
  return testPath ? `${source.commands.test} ${shellQuote(testPath)}`.replace(/'([^' ]+)'$/, "$1") : null;
}

export class ProductCodingRunner {
  private readonly options: Options;
  constructor(options: Options) { this.options = options; }

  async run(taskId: string, source: PreparedExecutionSource): Promise<ProductCodingResult> {
    const timeoutMs = this.options.timeoutMs ?? 20 * 60_000;
    const session = await this.options.sandboxProvider.create({
      taskId,
      repository: source.repository,
      gatewayUrl: this.options.route.gatewayUrl,
      timeoutMs,
    });
    let phase: "locked" | "dependency-setup" | "coding" | "testing" | "offline" = "locked";
    try {
      await session.setNetworkPhase("dependency-setup");
      phase = "dependency-setup";
      if (source.commands.install) {
        const install = await session.exec({ command: source.commands.install, cwd: session.workspacePath, timeoutMs });
        if (install.exitCode !== 0) throw new Error("coding dependency setup failed");
      }
      await session.setNetworkPhase("coding");
      phase = "coding";
      const outcome = await this.options.harnessRunner.run(session, {
        ticketText: `${source.requirement}\n\nApproved plan:\n${source.plan}\n\nFor bug fixes, add a focused regression test that fails before the fix and passes after it.`,
        model: this.options.route.model,
        gatewayUrl: this.options.route.gatewayUrl,
        runToken: this.options.route.runToken,
        maxTurns: this.options.maxTurns ?? 24,
        timeoutMs,
      });
      if (outcome.status !== "completed") throw new Error(`coding harness ended with ${outcome.status}${outcome.limit ? ` (${outcome.limit})` : ""}`);
      const costUsd = await (this.options.readCostUsd?.() ?? Promise.resolve(0));
      if (!Number.isFinite(costUsd) || costUsd < 0) throw new Error("execution cost must be non-negative");
      return {
        patch: outcome.patch.patch,
        reproductionCommand: reproductionCommand(source, outcome.patch.patch),
        costUsd,
        summary: `${this.options.harnessRunner.name} completed in ${outcome.turnsUsed} turns.`,
      };
    } finally {
      try {
        if (phase === "coding") {
          await session.setNetworkPhase("testing");
          phase = "testing";
        } else if (phase === "dependency-setup") {
          await session.setNetworkPhase("offline");
          phase = "offline";
        }
      } finally {
        await session.destroy();
      }
    }
  }
}

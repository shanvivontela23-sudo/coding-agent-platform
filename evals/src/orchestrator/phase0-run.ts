import type { HarnessRunOutcome, HarnessRunner } from "../harness/types.js";
import type { PinnedRepositoryArchive, SandboxProvider } from "../sandbox/types.js";
import { buildPhase0HarnessTicket } from "./instruction.js";
import type { Phase0LiveConfig } from "./live-config.js";

export type Phase0RunInput = {
  readonly taskId: string;
  readonly repository: PinnedRepositoryArchive;
  readonly gatewayUrl: string;
  readonly runToken: string;
  readonly ticketText: string;
  readonly model: string;
  readonly maxTurns: number;
  readonly timeoutMs: number;
  readonly dependencySetupCommand?: string;
  readonly extraDependencyHosts?: readonly string[];
  readonly harness: HarnessRunner;
};

export type Phase0RunOrchestratorOptions = {
  readonly sandboxProvider: SandboxProvider;
  readonly liveConfig: Phase0LiveConfig;
};

export class Phase0RunOrchestrator {
  private readonly sandboxProvider: SandboxProvider;
  private readonly liveConfig: Phase0LiveConfig;

  constructor(options: Phase0RunOrchestratorOptions) {
    this.sandboxProvider = options.sandboxProvider;
    this.liveConfig = options.liveConfig;
  }

  async run(input: Phase0RunInput): Promise<HarnessRunOutcome> {
    const session = await this.sandboxProvider.create({
      taskId: input.taskId,
      repository: input.repository,
      gatewayUrl: input.gatewayUrl,
      template: this.liveConfig.e2bTemplateId,
      timeoutMs: input.timeoutMs,
      ...(input.extraDependencyHosts
        ? { extraDependencyHosts: input.extraDependencyHosts }
        : {}),
    });

    try {
      await session.setNetworkPhase("dependency-setup");
      if (input.dependencySetupCommand) {
        const setup = await session.exec({
          command: input.dependencySetupCommand,
          cwd: session.workspacePath,
          timeoutMs: input.timeoutMs,
        });
        if (setup.exitCode !== 0) {
          throw new Error(`dependency setup failed: ${setup.stderr.slice(-2_048)}`);
        }
      }
      await session.setNetworkPhase("coding");
      return await input.harness.run(session, {
        ticketText: buildPhase0HarnessTicket(input.ticketText),
        model: input.model,
        gatewayUrl: input.gatewayUrl,
        runToken: input.runToken,
        maxTurns: input.maxTurns,
        timeoutMs: input.timeoutMs,
      });
    } finally {
      await session.destroy().catch(() => undefined);
    }
  }
}

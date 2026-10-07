import type {
  SandboxCreateRequest,
  SandboxNetworkPhase,
  SandboxPatch,
  SandboxProvider,
  SandboxSession,
  SandboxSnapshot,
  SandboxCommand,
  SandboxCommandResult,
} from "../sandbox/types.js";

export type SandboxCost = {
  readonly sandboxSeconds: number;
  readonly sandboxCostUsd: number;
};

export type MeteredSandboxProviderOptions = {
  readonly sandboxUsdPerSecond: number;
  readonly clock?: () => number;
};

export class MeteredSandboxProvider implements SandboxProvider {
  private readonly provider: SandboxProvider;
  private readonly sandboxUsdPerSecond: number;
  private readonly clock: () => number;
  private totalMilliseconds = 0;

  constructor(provider: SandboxProvider, options: MeteredSandboxProviderOptions) {
    if (!Number.isFinite(options.sandboxUsdPerSecond) || options.sandboxUsdPerSecond < 0) {
      throw new Error("sandboxUsdPerSecond must be a finite non-negative number");
    }
    this.provider = provider;
    this.sandboxUsdPerSecond = options.sandboxUsdPerSecond;
    this.clock = options.clock ?? Date.now;
  }

  async create(request: SandboxCreateRequest): Promise<SandboxSession> {
    const startedAtMs = this.clock();
    const session = await this.provider.create(request);
    let destroyed = false;
    const recordDestroyed = () => {
      this.totalMilliseconds += Math.max(0, this.clock() - startedAtMs);
    };

    return {
      id: session.id,
      workspacePath: session.workspacePath,
      baselineCommitSha: session.baselineCommitSha,
      exec: async (command: SandboxCommand): Promise<SandboxCommandResult> => await session.exec(command),
      readFile: async (path: string): Promise<string> => await session.readFile(path),
      writeFile: async (path: string, data: string | ArrayBuffer): Promise<void> => await session.writeFile(path, data),
      setNetworkPhase: async (phase: SandboxNetworkPhase): Promise<void> => await session.setNetworkPhase(phase),
      exportPatch: async (): Promise<SandboxPatch> => await session.exportPatch(),
      snapshot: async (name?: string): Promise<SandboxSnapshot> => await session.snapshot(name),
      destroy: async (): Promise<void> => {
        if (destroyed) return;
        destroyed = true;
        try {
          await session.destroy();
        } finally {
          recordDestroyed();
        }
      },
    };
  }

  cost(): SandboxCost {
    const sandboxSeconds = this.totalMilliseconds / 1_000;
    return {
      sandboxSeconds,
      sandboxCostUsd: sandboxSeconds * this.sandboxUsdPerSecond,
    };
  }
}

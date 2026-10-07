import { describe, expect, it } from "vitest";
import { MeteredSandboxProvider } from "../src/operator/metered-sandbox-provider.js";
import type {
  SandboxCommand,
  SandboxCommandResult,
  SandboxCreateRequest,
  SandboxNetworkPhase,
  SandboxPatch,
  SandboxProvider,
  SandboxSession,
  SandboxSnapshot,
} from "../src/sandbox/types.js";

class FakeSession implements SandboxSession {
  readonly id: string;
  readonly workspacePath = "/workspace/repo";
  readonly baselineCommitSha = "a".repeat(40);
  destroys = 0;
  constructor(id: string) { this.id = id; }
  async exec(_command: SandboxCommand): Promise<SandboxCommandResult> { return { exitCode: 0, stdout: "", stderr: "" }; }
  async readFile(): Promise<string> { return ""; }
  async writeFile(): Promise<void> {}
  async setNetworkPhase(_phase: SandboxNetworkPhase): Promise<void> {}
  async exportPatch(): Promise<SandboxPatch> { return { patch: "", status: "" }; }
  async snapshot(): Promise<SandboxSnapshot> { return { id: `${this.id}-snapshot` }; }
  async destroy(): Promise<void> { this.destroys += 1; }
}

class FakeProvider implements SandboxProvider {
  created = 0;
  async create(_request: SandboxCreateRequest): Promise<SandboxSession> {
    this.created += 1;
    return new FakeSession(`sandbox-${this.created}`);
  }
}

const request: SandboxCreateRequest = {
  taskId: "task-1",
  repository: {
    pinnedCommit: "a".repeat(40),
    archiveSha256: "b".repeat(64),
    archive: new Uint8Array(),
  },
  gatewayUrl: "https://gateway.example.test",
};

describe("sandbox accounting", () => {
  it("sums coding and evaluator lifetimes and computes deterministic sandbox cost", async () => {
    let nowMs = 0;
    const metered = new MeteredSandboxProvider(new FakeProvider(), {
      clock: () => nowMs,
      sandboxUsdPerSecond: 0.02,
    });

    const coding = await metered.create(request);
    nowMs = 1_250;
    await coding.destroy();

    const evaluator = await metered.create({ ...request, taskId: "task-1:collector" });
    nowMs = 4_750;
    await evaluator.destroy();
    await evaluator.destroy();

    expect(metered.cost()).toEqual({
      sandboxSeconds: 4.75,
      sandboxCostUsd: 0.095,
    });
  });

  it("rejects an invalid sandbox price", () => {
    expect(() => new MeteredSandboxProvider(new FakeProvider(), { sandboxUsdPerSecond: -0.01 })).toThrow("sandboxUsdPerSecond");
  });
});

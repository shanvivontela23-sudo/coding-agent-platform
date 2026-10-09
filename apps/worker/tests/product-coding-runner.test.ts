import { describe, expect, it } from "vitest";
import type { HarnessRunOutcome, HarnessRunRequest, HarnessRunner } from "../../../evals/src/harness/types.js";
import type { SandboxCommand, SandboxCommandResult, SandboxCreateRequest, SandboxNetworkPhase, SandboxPatch, SandboxProvider, SandboxSession, SandboxSnapshot } from "../../../evals/src/sandbox/types.js";
import type { PreparedExecutionSource } from "../src/execution-source.js";
import { ProductCodingRunner } from "../src/product-coding-runner.js";

const source: PreparedExecutionSource = {
  repository: { pinnedCommit: "d".repeat(40), archiveSha256: "e".repeat(64), archive: new Uint8Array([1, 2, 3]) },
  jobType: "bug_fix",
  requirement: "Retry recovers after save failure",
  plan: "Preserve state and add a test",
  commands: { install: "pnpm install --offline", test: "pnpm test", build: "pnpm build" },
  reviewFocus: "retry transition",
};

class Session implements SandboxSession {
  readonly id = "coding-sandbox";
  readonly workspacePath = "/workspace/repo";
  readonly baselineCommitSha = source.repository.pinnedCommit;
  readonly phases: SandboxNetworkPhase[] = [];
  readonly commands: string[] = [];
  async exec(request: SandboxCommand): Promise<SandboxCommandResult> { this.commands.push(request.command); return { exitCode: 0, stdout: "", stderr: "" }; }
  async readFile(): Promise<string> { return ""; }
  async writeFile(): Promise<void> {}
  async setNetworkPhase(phase: SandboxNetworkPhase): Promise<void> { this.phases.push(phase); }
  async exportPatch(): Promise<SandboxPatch> { return { patch: "unused", status: "" }; }
  async snapshot(): Promise<SandboxSnapshot> { return { id: "snapshot" }; }
  async destroy(): Promise<void> {}
}

class Provider implements SandboxProvider {
  readonly session = new Session();
  request: SandboxCreateRequest | null = null;
  async create(request: SandboxCreateRequest): Promise<SandboxSession> { this.request = request; return this.session; }
}

class Harness implements HarnessRunner {
  readonly name = "codex" as const;
  readonly version = "test";
  request: HarnessRunRequest | null = null;
  async run(_session: SandboxSession, request: HarnessRunRequest): Promise<HarnessRunOutcome> {
    this.request = request;
    return {
      status: "completed",
      limit: null,
      turnsUsed: 4,
      wallClockSeconds: 2,
      patch: {
        status: " M src/retry.ts\n?? src/retry.test.ts",
        patch: "diff --git a/src/retry.test.ts b/src/retry.test.ts\n--- a/src/retry.test.ts\n+++ b/src/retry.test.ts\n@@ -1 +1 @@\n-old\n+new\n",
      },
    };
  }
}

describe("ProductCodingRunner", () => {
  it("uses the existing SandboxProvider and HarnessRunner with an execution-scoped route", async () => {
    const provider = new Provider();
    const harness = new Harness();
    const runner = new ProductCodingRunner({
      sandboxProvider: provider,
      harnessRunner: harness,
      route: { gatewayUrl: "http://gateway.local/v1", runToken: "execution-token", model: "test-model" },
      readCostUsd: async () => 0.37,
    });

    const result = await runner.run("50000000-0000-4000-8000-000000000241", source);

    expect(provider.request).toMatchObject({ repository: source.repository, gatewayUrl: "http://gateway.local/v1" });
    expect(provider.request).not.toHaveProperty("githubToken");
    expect(provider.request).not.toHaveProperty("databaseUrl");
    expect(provider.session.phases).toContain("dependency-setup");
    expect(provider.session.phases).toContain("coding");
    expect(provider.session.phases.at(-1)).toBe("testing");
    expect(provider.session.commands).toContain("pnpm install --offline");
    expect(harness.request).toMatchObject({
      ticketText: expect.stringContaining(source.requirement),
      gatewayUrl: "http://gateway.local/v1",
      runToken: "execution-token",
      model: "test-model",
    });
    expect(result.patch).toContain("src/retry.test.ts");
    expect(result.reproductionCommand).toBe("pnpm test src/retry.test.ts");
    expect(result.costUsd).toBe(0.37);
  });

  it("rejects non-completed harness outcomes", async () => {
    const harness: HarnessRunner = {
      name: "codex",
      version: "test",
      async run() { return { status: "limit-hit", limit: "spend", turnsUsed: 1, wallClockSeconds: 1, patch: { patch: "", status: "" } }; },
    };
    const runner = new ProductCodingRunner({ sandboxProvider: new Provider(), harnessRunner: harness, route: { gatewayUrl: "http://gateway.local/v1", runToken: "token", model: "model" } });
    await expect(runner.run("50000000-0000-4000-8000-000000000242", source)).rejects.toThrow(/limit-hit/);
  });
});

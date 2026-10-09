import { describe, expect, it, vi } from "vitest";
import type { HarnessRunOutcome, HarnessRunRequest, HarnessRunner } from "../../../evals/src/harness/types.js";
import type { SandboxCommand, SandboxCommandResult, SandboxCreateRequest, SandboxNetworkPhase, SandboxPatch, SandboxProvider, SandboxSession, SandboxSnapshot } from "../../../evals/src/sandbox/types.js";
import type { PreparedExecutionSource } from "../src/execution-source.js";
import { CodingRunError, ProductCodingRunner } from "../src/product-coding-runner.js";

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
  destroyed = false;
  async exec(request: SandboxCommand): Promise<SandboxCommandResult> { this.commands.push(request.command); return { exitCode: 0, stdout: "", stderr: "" }; }
  async readFile(): Promise<string> { return ""; }
  async writeFile(): Promise<void> {}
  async setNetworkPhase(phase: SandboxNetworkPhase): Promise<void> { this.phases.push(phase); }
  async exportPatch(): Promise<SandboxPatch> { return { patch: "unused", status: "" }; }
  async snapshot(): Promise<SandboxSnapshot> { return { id: "snapshot" }; }
  async destroy(): Promise<void> { this.destroyed = true; }
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
  calls = 0;
  async run(_session: SandboxSession, request: HarnessRunRequest): Promise<HarnessRunOutcome> {
    this.calls += 1;
    this.request = request;
    return {
      status: "completed",
      limit: null,
      turnsUsed: 4,
      wallClockSeconds: 2,
      patch: {
        status: " M src/retry.ts\n?? src/retry.test.ts",
        patch: "diff --git /dev/null b/src/retry.test.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/retry.test.ts\n@@ -0,0 +1 @@\n+test('retry', () => expect(true).toBe(true));\n",
      },
    };
  }
}

describe("ProductCodingRunner", () => {
  it("uses the existing SandboxProvider and HarnessRunner with an execution-scoped route and required reconciled cost", async () => {
    const provider = new Provider();
    const harness = new Harness();
    const runner = new ProductCodingRunner({
      sandboxProvider: provider,
      harnessRunner: harness,
      route: { gatewayUrl: "http://gateway.local/v1", runToken: "execution-token", model: "test-model" },
      readCostUsd: async () => 0.37,
    });

    const result = await runner.run("50000000-0000-4000-8000-000000000241", source, { signal: new AbortController().signal, timeoutMs: 12_000 });

    expect(provider.request).toMatchObject({ repository: source.repository, gatewayUrl: "http://gateway.local/v1", timeoutMs: 12_000 });
    expect(provider.session.phases).toContain("dependency-setup");
    expect(provider.session.phases).toContain("coding");
    expect(harness.request).toMatchObject({ timeoutMs: 12_000, gatewayUrl: "http://gateway.local/v1", runToken: "execution-token", model: "test-model" });
    expect(result.reproductionCommand).toBe("pnpm test src/retry.test.ts");
    expect(result.costUsd).toBe(0.37);
  });

  it("reconciles and exposes cost when the harness ends non-completed", async () => {
    const harness: HarnessRunner = {
      name: "codex",
      version: "test",
      async run() { return { status: "limit-hit", limit: "spend", turnsUsed: 1, wallClockSeconds: 1, patch: { patch: "", status: "" } }; },
    };
    const runner = new ProductCodingRunner({
      sandboxProvider: new Provider(),
      harnessRunner: harness,
      route: { gatewayUrl: "http://gateway.local/v1", runToken: "token", model: "model" },
      readCostUsd: async () => 0.19,
    });
    const error = await runner.run("50000000-0000-4000-8000-000000000242", source, { signal: new AbortController().signal, timeoutMs: 5_000 }).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(CodingRunError);
    expect((error as CodingRunError).costUsd).toBe(0.19);
    expect((error as Error).message).toMatch(/limit-hit/);
  });

  it("destroys the sandbox immediately on abort and does not invoke the harness again", async () => {
    const provider = new Provider();
    const controller = new AbortController();
    let release: (() => void) | null = null;
    const harness: HarnessRunner & { calls: number } = {
      name: "codex",
      version: "test",
      calls: 0,
      async run() {
        this.calls += 1;
        await new Promise<void>((resolve) => { release = resolve; });
        return { status: "completed", limit: null, turnsUsed: 1, wallClockSeconds: 1, patch: { patch: "", status: "" } };
      },
    };
    const readCostUsd = vi.fn(async () => 0.11);
    const runner = new ProductCodingRunner({ sandboxProvider: provider, harnessRunner: harness, route: { gatewayUrl: "http://gateway.local/v1", runToken: "token", model: "model" }, readCostUsd });
    const running = runner.run("50000000-0000-4000-8000-000000000243", source, { signal: controller.signal, timeoutMs: 30_000 });
    await Promise.resolve(); await Promise.resolve();
    controller.abort();
    await expect(running).rejects.toThrow(/abort/i);
    expect(provider.session.destroyed).toBe(true);
    expect(harness.calls).toBe(1);
    release?.();
    await Promise.resolve();
    expect(harness.calls).toBe(1);
    expect(readCostUsd).toHaveBeenCalledTimes(1);
  });
});

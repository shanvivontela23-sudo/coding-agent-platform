import { describe, expect, it } from "vitest";
import type { SandboxCommand, SandboxCommandResult, SandboxCreateRequest, SandboxNetworkPhase, SandboxPatch, SandboxProvider, SandboxSession, SandboxSnapshot } from "../../../evals/src/sandbox/types.js";
import type { PreparedExecutionSource } from "../src/execution-source.js";
import { verifyExecution } from "../src/verification.js";

const source: PreparedExecutionSource = {
  repository: { pinnedCommit: "a".repeat(40), archiveSha256: "b".repeat(64), archive: new Uint8Array([1]) },
  jobType: "bug_fix",
  requirement: "Retry should recover after save failure",
  plan: "Preserve state and add a regression test",
  commands: { install: "pnpm install --offline", test: "pnpm test", build: "pnpm build" },
  reviewFocus: "Retry state transition",
};

class FakeSession implements SandboxSession {
  readonly id: string;
  readonly workspacePath = "/workspace/repo";
  readonly baselineCommitSha = source.repository.pinnedCommit;
  readonly phases: SandboxNetworkPhase[] = [];
  readonly commands: string[] = [];
  private readonly mode: "baseline" | "patched";
  constructor(id: string, mode: "baseline" | "patched") { this.id = id; this.mode = mode; }
  async exec(request: SandboxCommand): Promise<SandboxCommandResult> {
    this.commands.push(request.command);
    if (request.command.startsWith("git apply")) return { exitCode: 0, stdout: "", stderr: "" };
    if (request.command === "pnpm install --offline") return { exitCode: 0, stdout: "", stderr: "" };
    if (request.command === "pnpm test") return { exitCode: 1, stdout: "", stderr: "known baseline failure" };
    if (request.command === "pnpm build") return this.mode === "baseline"
      ? { exitCode: 0, stdout: "", stderr: "" }
      : { exitCode: 1, stdout: "", stderr: "new build failure" };
    if (request.command === "pnpm test src/retry.test.ts") return this.mode === "baseline"
      ? { exitCode: 1, stdout: "", stderr: "bug reproduced" }
      : { exitCode: 0, stdout: "fixed", stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  }
  async readFile(): Promise<string> { return ""; }
  async writeFile(): Promise<void> {}
  async setNetworkPhase(phase: SandboxNetworkPhase): Promise<void> { this.phases.push(phase); }
  async exportPatch(): Promise<SandboxPatch> { return { patch: "", status: "" }; }
  async snapshot(): Promise<SandboxSnapshot> { return { id: `${this.id}-snapshot` }; }
  async destroy(): Promise<void> {}
}

class FakeProvider implements SandboxProvider {
  readonly requests: SandboxCreateRequest[] = [];
  readonly sessions: FakeSession[] = [];
  async create(request: SandboxCreateRequest): Promise<SandboxSession> {
    this.requests.push(request);
    const session = new FakeSession(`sandbox-${this.sessions.length + 1}`, this.sessions.length === 0 ? "baseline" : "patched");
    this.sessions.push(session);
    return session;
  }
}

describe("B2 verification", () => {
  it("runs baseline and patched checks in separate fresh model-free sandboxes", async () => {
    const provider = new FakeProvider();
    const result = await verifyExecution({
      sandboxProvider: provider,
      taskId: "40000000-0000-4000-8000-000000000231",
      source,
      patch: "diff --git a/src/retry.ts b/src/retry.ts\n--- a/src/retry.ts\n+++ b/src/retry.ts\n@@ -1 +1 @@\n-old\n+new\n",
      reproductionCommand: "pnpm test src/retry.test.ts",
    });

    expect(provider.sessions).toHaveLength(2);
    expect(provider.requests.every((request) => request.repository === source.repository)).toBe(true);
    expect(provider.requests.every((request) => request.gatewayUrl === "http://127.0.0.1:1")).toBe(true);
    expect(provider.sessions[0]!.commands.some((command) => command.startsWith("git apply"))).toBe(false);
    expect(provider.sessions[1]!.commands.some((command) => command.startsWith("git apply"))).toBe(true);
    expect(provider.sessions.flatMap((session) => session.phases)).not.toContain("coding");

    expect(result.checks).toEqual([
      { name: "test", command: "pnpm test", baselineExitCode: 1, patchedExitCode: 1, status: "pre_existing" },
      { name: "build", command: "pnpm build", baselineExitCode: 0, patchedExitCode: 1, status: "failed" },
    ]);
    expect(result.hasNewFailures).toBe(true);
    expect(result.reproduce).toEqual({
      command: "pnpm test src/retry.test.ts",
      baselineExitCode: 1,
      patchedExitCode: 0,
      reproduced: true,
    });
  });

  it("marks bug proof not reproduced when no reproduction command exists", async () => {
    const result = await verifyExecution({
      sandboxProvider: new FakeProvider(),
      taskId: "40000000-0000-4000-8000-000000000232",
      source,
      patch: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n",
      reproductionCommand: null,
    });
    expect(result.reproduce.reproduced).toBe(false);
    expect(result.reproduce.command).toBeNull();
  });
});

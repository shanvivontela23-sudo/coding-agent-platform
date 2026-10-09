import { describe, expect, it } from "vitest";
import type { SandboxCommand, SandboxCommandResult, SandboxCreateRequest, SandboxNetworkPhase, SandboxPatch, SandboxProvider, SandboxSession, SandboxSnapshot } from "../../../evals/src/sandbox/types.js";
import type { PreparedExecutionSource } from "../src/execution-source.js";
import { verifyExecution } from "../src/verification.js";

const source: PreparedExecutionSource = {
  repository: { pinnedCommit: "a".repeat(40), archiveSha256: "b".repeat(64), archive: new Uint8Array([1]) },
  jobType: "bug_fix",
  requirement: "Retry should recover after save failure",
  plan: "Preserve state and add a regression test",
  commands: { install: null, test: "pnpm test", build: null },
  reviewFocus: "Retry state transition",
};

const patch = [
  "diff --git a/src/retry.ts b/src/retry.ts",
  "--- a/src/retry.ts",
  "+++ b/src/retry.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "diff --git /dev/null b/src/retry.test.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/retry.test.ts",
  "@@ -0,0 +1 @@",
  "+expect(retry()).toBe(true);",
  "",
].join("\n");

class FakeSession implements SandboxSession {
  readonly workspacePath = "/workspace/repo";
  readonly baselineCommitSha = source.repository.pinnedCommit;
  readonly phases: SandboxNetworkPhase[] = [];
  readonly commands: string[] = [];
  readonly writes: string[] = [];
  destroyed = false;
  constructor(
    readonly id: string,
    private readonly results: Readonly<Record<string, SandboxCommandResult>>,
  ) {}
  async exec(request: SandboxCommand): Promise<SandboxCommandResult> {
    this.commands.push(request.command);
    if (request.command.startsWith("git apply")) return { exitCode: 0, stdout: "", stderr: "" };
    return this.results[request.command] ?? { exitCode: 0, stdout: "", stderr: "" };
  }
  async readFile(): Promise<string> { return ""; }
  async writeFile(path: string, data: string | ArrayBuffer): Promise<void> { this.writes.push(`${path}:${typeof data === "string" ? data : "binary"}`); }
  async setNetworkPhase(phase: SandboxNetworkPhase): Promise<void> { this.phases.push(phase); }
  async exportPatch(): Promise<SandboxPatch> { return { patch: "", status: "" }; }
  async snapshot(): Promise<SandboxSnapshot> { return { id: `${this.id}-snapshot` }; }
  async destroy(): Promise<void> { this.destroyed = true; }
}

class FakeProvider implements SandboxProvider {
  readonly requests: SandboxCreateRequest[] = [];
  readonly sessions: FakeSession[] = [];
  constructor(
    private readonly baselineResults: Readonly<Record<string, SandboxCommandResult>>,
    private readonly patchedResults: Readonly<Record<string, SandboxCommandResult>>,
  ) {}
  async create(request: SandboxCreateRequest): Promise<SandboxSession> {
    this.requests.push(request);
    const baseline = this.sessions.length === 0;
    const session = new FakeSession(baseline ? "baseline" : "patched", baseline ? this.baselineResults : this.patchedResults);
    this.sessions.push(session);
    return session;
  }
}

const ok = (stdout = ""): SandboxCommandResult => ({ exitCode: 0, stdout, stderr: "" });
const fail = (stderr: string, stdout = ""): SandboxCommandResult => ({ exitCode: 1, stdout, stderr });

async function verifyWith(baselineRepro: SandboxCommandResult, patchedRepro: SandboxCommandResult, baselineTest = ok(), patchedTest = ok()) {
  const provider = new FakeProvider(
    { "pnpm test": baselineTest, "pnpm test src/retry.test.ts": baselineRepro },
    { "pnpm test": patchedTest, "pnpm test src/retry.test.ts": patchedRepro },
  );
  const result = await verifyExecution({
    sandboxProvider: provider,
    taskId: "40000000-0000-4000-8000-000000000231",
    source,
    patch,
    reproductionCommand: "pnpm test src/retry.test.ts",
    timeoutMs: 20_000,
    signal: new AbortController().signal,
  });
  return { provider, result };
}

describe("B2 verification", () => {
  it("applies only test hunks on baseline and accepts a real assertion failure as reproduce proof", async () => {
    const { provider, result } = await verifyWith(
      fail("AssertionError: expected false to be true\nFAIL src/retry.test.ts > retry recovers"),
      ok("PASS src/retry.test.ts > retry recovers"),
    );

    expect(provider.sessions).toHaveLength(2);
    expect(provider.sessions[0]!.commands.some((command) => command.startsWith("git apply"))).toBe(true);
    expect(provider.sessions[0]!.writes.join("\n")).toContain("src/retry.test.ts");
    expect(provider.sessions[0]!.writes.join("\n")).not.toContain("src/retry.ts b/src/retry.ts");
    expect(provider.sessions[1]!.writes.join("\n")).toContain("src/retry.ts");
    expect(result.reproduce).toMatchObject({
      command: "pnpm test src/retry.test.ts",
      baselineExitCode: 1,
      patchedExitCode: 0,
      baselineClassification: "assertion_failure",
      patchedClassification: "passed",
      reproduced: true,
    });
    expect(result.reproduce.baselineOutput).toContain("AssertionError");
  });

  it("does not treat a missing-file or collection error as reproduce proof", async () => {
    const { result } = await verifyWith(
      fail("Error: No test files found: src/retry.test.ts"),
      ok("PASS src/retry.test.ts"),
    );
    expect(result.reproduce.reproduced).toBe(false);
    expect(result.reproduce.baselineClassification).toBe("error");
  });

  it("does not treat a test that already passes on baseline as reproduce proof", async () => {
    const { result } = await verifyWith(ok("PASS src/retry.test.ts"), ok("PASS src/retry.test.ts"));
    expect(result.reproduce.reproduced).toBe(false);
    expect(result.reproduce.baselineClassification).toBe("passed");
  });

  it("marks a bug fix with no test-file hunks as not reproduced", async () => {
    const provider = new FakeProvider({ "pnpm test": ok() }, { "pnpm test": ok() });
    const noTestPatch = "diff --git a/src/retry.ts b/src/retry.ts\n--- a/src/retry.ts\n+++ b/src/retry.ts\n@@ -1 +1 @@\n-old\n+new\n";
    const result = await verifyExecution({
      sandboxProvider: provider,
      taskId: "40000000-0000-4000-8000-000000000232",
      source,
      patch: noTestPatch,
      reproductionCommand: null,
      timeoutMs: 20_000,
      signal: new AbortController().signal,
    });
    expect(result.reproduce.reproduced).toBe(false);
    expect(result.reproduce.reason).toMatch(/test file/i);
  });

  it("compares failing test names and marks unknown comparisons pre_existing_unverified", async () => {
    const named = await verifyWith(
      fail("AssertionError: expected false to be true\nFAIL src/retry.test.ts > retry recovers"),
      ok("PASS src/retry.test.ts"),
      fail("FAIL src/known.test.ts > known failure"),
      fail("FAIL src/known.test.ts > known failure\nFAIL src/new.test.ts > new failure"),
    );
    expect(named.result.checks[0]?.status).toBe("failed");
    expect(named.result.hasNewFailures).toBe(true);

    const unknown = await verifyWith(
      fail("AssertionError: expected false to be true\nFAIL src/retry.test.ts > retry recovers"),
      ok("PASS src/retry.test.ts"),
      fail("test command exited 1"),
      fail("test command exited 1"),
    );
    expect(unknown.result.checks[0]?.status).toBe("pre_existing_unverified");
    expect(unknown.result.hasNewFailures).toBe(false);
  });

  it("destroys verification sandboxes promptly when aborted", async () => {
    const controller = new AbortController();
    const provider = new FakeProvider({ "pnpm test": ok() }, { "pnpm test": ok() });
    controller.abort();
    await expect(verifyExecution({
      sandboxProvider: provider,
      taskId: "40000000-0000-4000-8000-000000000233",
      source,
      patch,
      reproductionCommand: "pnpm test src/retry.test.ts",
      timeoutMs: 20_000,
      signal: controller.signal,
    })).rejects.toThrow(/abort/i);
    expect(provider.sessions.every((session) => session.destroyed)).toBe(true);
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { SandboxCommand, SandboxCommandResult, SandboxPatch, SandboxProvider, SandboxSession, SandboxSnapshot } from "../../../evals/src/sandbox/types.js";
import type { PreparedExecutionSource } from "../src/execution-source.js";
import { verifyExecution } from "../src/verification.js";

// Real "fails before the fix" output captured on each stack's toolchain
// (pytest 8, Maven Surefire 3 + JUnit 5, Gradle 8, dotnet 8 + xUnit) for the
// evals/stack-fixtures refund bug. Reproduce-first proof must read each one as
// an assertion failure, not as an error that would void the proof.
const output = (name: string) => readFileSync(new URL(`./fixtures/runner-output/${name}`, import.meta.url), "utf8");

const cases = [
  { stack: "pytest", test: "python -m pytest", focused: "python -m pytest tests/test_second_refund.py", file: "tests/test_second_refund.py", out: output("pytest-fail.txt") },
  { stack: "maven", test: "mvn -B test", focused: "mvn -B test -Dtest=SecondRefundTest -Dsurefire.failIfNoSpecifiedTests=false", file: "src/test/java/demo/SecondRefundTest.java", out: output("maven-surefire-fail.txt") },
  { stack: "gradle", test: "gradle --no-daemon test", focused: "gradle --no-daemon test --tests SecondRefundTest", file: "src/test/java/demo/SecondRefundTest.java", out: output("gradle-test-fail.txt") },
  { stack: "dotnet", test: "dotnet test Refunds.sln --no-restore", focused: "dotnet test Refunds.sln --no-restore --filter FullyQualifiedName~SecondRefundTests", file: "tests/Refunds.Tests/SecondRefundTests.cs", out: output("dotnet-test-fail.txt") },
];

class Session implements SandboxSession {
  readonly workspacePath = "/workspace/repo";
  readonly baselineCommitSha = "a".repeat(40);
  constructor(readonly id: string, private readonly focused: string, private readonly failure: string) {}
  async exec(request: SandboxCommand): Promise<SandboxCommandResult> {
    if (request.command.startsWith("git hash-object")) return { exitCode: 0, stdout: `${"c".repeat(40)}\n`, stderr: "" };
    if (request.command.startsWith("if test -x")) return { exitCode: 0, stdout: "100644\n", stderr: "" };
    if (request.command === this.focused && this.id === "baseline") return { exitCode: 1, stdout: this.failure, stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  }
  async readFile(): Promise<string> { return ""; }
  async writeFile(): Promise<void> {}
  async setNetworkPhase(): Promise<void> {}
  async exportPatch(): Promise<SandboxPatch> { return { patch: "", status: "" }; }
  async snapshot(): Promise<SandboxSnapshot> { return { id: `${this.id}-snapshot` }; }
  async destroy(): Promise<void> {}
}

describe.each(cases)("reproduce-first proof with real $stack output", ({ test, focused, file, out }) => {
  it("classifies the failing regression test as an assertion failure and the fix as passing", async () => {
    let created = 0;
    const provider: SandboxProvider = { create: async () => new Session(created++ === 0 ? "baseline" : "patched", focused, out) };
    const source: PreparedExecutionSource = {
      repository: { pinnedCommit: "a".repeat(40), archiveSha256: "b".repeat(64), archive: new Uint8Array([1]) },
      jobType: "bug_fix", requirement: "Second refund is capped", plan: "Cap at remaining balance", reviewFocus: "refunds",
      commands: { install: "install", test, build: null },
    };
    const patch = `diff --git /dev/null b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1 @@\n+test\n`;
    const result = await verifyExecution({ sandboxProvider: provider, taskId: "40000000-0000-4000-8000-000000000777", source, patch, reproductionCommand: focused, timeoutMs: 20_000, signal: new AbortController().signal });
    expect(result.reproduce.baselineClassification).toBe("assertion_failure");
    expect(result.reproduce.patchedClassification).toBe("passed");
    expect(result.reproduce.reproduced).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import type { SandboxCommand, SandboxCommandResult, SandboxPatch, SandboxProvider, SandboxSession, SandboxSnapshot } from "../../../evals/src/sandbox/types.js";
import type { PreparedExecutionSource } from "../src/execution-source.js";
import { verifyExecution } from "../src/verification.js";

const source: PreparedExecutionSource = {
  repository: { pinnedCommit: "a".repeat(40), archiveSha256: "b".repeat(64), archive: new Uint8Array([1]) },
  jobType: "feature",
  requirement: "Update tool",
  plan: "Update src/tool.ts",
  commands: { install: "npm ci", test: "npm test", build: "npm run build" },
  reviewFocus: "Tool behavior",
};
const patch = [
  "diff --git a/src/tool.ts b/src/tool.ts",
  "--- a/src/tool.ts",
  "+++ b/src/tool.ts",
  "@@ -1 +1 @@",
  "-export const value = 1;",
  "+export const value = 2;",
  "",
].join("\n");

class Session implements SandboxSession {
  readonly workspacePath = "/workspace/repo";
  readonly baselineCommitSha = source.repository.pinnedCommit;
  readonly commands: string[] = [];
  constructor(readonly id: string) {}
  async exec(request: SandboxCommand): Promise<SandboxCommandResult> {
    this.commands.push(request.command);
    if (request.command.startsWith("git hash-object")) return { exitCode: 0, stdout: `${"c".repeat(40)}\n`, stderr: "" };
    if (request.command.startsWith("if test -x")) return { exitCode: 0, stdout: "100644\n", stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  }
  async readFile(): Promise<string> { return ""; }
  async writeFile(): Promise<void> {}
  async setNetworkPhase(): Promise<void> {}
  async exportPatch(): Promise<SandboxPatch> { return { patch: "", status: "" }; }
  async snapshot(): Promise<SandboxSnapshot> { return { id: `${this.id}-snapshot` }; }
  async destroy(): Promise<void> {}
}
class Provider implements SandboxProvider {
  readonly sessions: Session[] = [];
  async create(): Promise<SandboxSession> {
    const session = new Session(this.sessions.length === 0 ? "baseline" : "patched");
    this.sessions.push(session);
    return session;
  }
}

describe("B4 verification manifest timing", () => {
  it("captures verifiedFiles immediately after applying the full patch and before patched test/build commands", async () => {
    const provider = new Provider();
    await verifyExecution({ sandboxProvider: provider, taskId: "40000000-0000-4000-8000-000000000801", source, patch, reproductionCommand: null, timeoutMs: 20_000, signal: new AbortController().signal });
    const patched = provider.sessions[1]!;
    const hashIndex = patched.commands.findIndex((command) => command.startsWith("git hash-object"));
    const testIndex = patched.commands.indexOf("npm test");
    const buildIndex = patched.commands.indexOf("npm run build");
    expect(hashIndex).toBeGreaterThan(-1);
    expect(hashIndex).toBeLessThan(testIndex);
    expect(hashIndex).toBeLessThan(buildIndex);
  });
});

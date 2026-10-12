import { describe, expect, it } from "vitest";
import type { SandboxCommand, SandboxCommandResult, SandboxCreateRequest, SandboxNetworkPhase, SandboxPatch, SandboxProvider, SandboxSession, SandboxSnapshot } from "../../../evals/src/sandbox/types.js";
import type { PreparedExecutionSource } from "../src/execution-source.js";
import { verifyExecution } from "../src/verification.js";

const source: PreparedExecutionSource = {
  repository: { pinnedCommit: "a".repeat(40), archiveSha256: "b".repeat(64), archive: new Uint8Array([1]) },
  jobType: "feature",
  requirement: "Make tool executable",
  plan: "Update src/tool.sh",
  commands: { install: "npm ci", test: "npm test", build: null },
  reviewFocus: "Executable tool",
};
const patch = [
  "diff --git a/src/tool.sh b/src/tool.sh",
  "old mode 100644",
  "new mode 100755",
  "--- a/src/tool.sh",
  "+++ b/src/tool.sh",
  "@@ -1 +1 @@",
  "-echo old",
  "+echo new",
  "",
].join("\n");

class Session implements SandboxSession {
  readonly workspacePath = "/workspace/repo";
  readonly baselineCommitSha = source.repository.pinnedCommit;
  constructor(readonly id: string) {}
  async exec(request: SandboxCommand): Promise<SandboxCommandResult> {
    if (request.command.startsWith("git hash-object")) return { exitCode: 0, stdout: `${"c".repeat(40)}\n`, stderr: "" };
    if (request.command.startsWith("test -x")) return { exitCode: 0, stdout: "100755\n", stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  }
  async readFile(): Promise<string> { return ""; }
  async writeFile(): Promise<void> {}
  async setNetworkPhase(_phase: SandboxNetworkPhase): Promise<void> {}
  async exportPatch(): Promise<SandboxPatch> { return { patch: "", status: "" }; }
  async snapshot(): Promise<SandboxSnapshot> { return { id: `${this.id}-snapshot` }; }
  async destroy(): Promise<void> {}
}
class Provider implements SandboxProvider {
  count = 0;
  async create(_request: SandboxCreateRequest): Promise<SandboxSession> { this.count += 1; return new Session(this.count === 1 ? "baseline" : "patched"); }
}

describe("B3 verified file manifest", () => {
  it("records git blob identity and executable mode from the patched verification sandbox", async () => {
    const result = await verifyExecution({ sandboxProvider: new Provider(), taskId: "40000000-0000-4000-8000-000000000731", source, patch, reproductionCommand: null, timeoutMs: 20_000, signal: new AbortController().signal });
    expect(result.verifiedFiles).toEqual([{ path: "src/tool.sh", blobSha: "c".repeat(40), mode: "100755", deleted: false }]);
  });
});

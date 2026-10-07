import { describe, expect, it } from "vitest";
import {
  InMemoryBaselineSuiteCache,
  TypeScriptNodeCollector,
  type RunResultWriter,
} from "../src/collector/index.js";
import type { RunResult } from "../src/domain/run-result.js";
import type {
  PinnedRepositoryArchive,
  SandboxCommand,
  SandboxCommandResult,
  SandboxNetworkPhase,
  SandboxPatch,
  SandboxProvider,
  SandboxSession,
  SandboxSnapshot,
} from "../src/sandbox/types.js";

class Writer implements RunResultWriter {
  rows: RunResult[] = [];
  async write(row: RunResult): Promise<void> { this.rows.push(row); }
}

class Session implements SandboxSession {
  readonly id = "collector";
  readonly workspacePath = "/workspace/repo";
  readonly baselineCommitSha = "b".repeat(40);
  phase: SandboxNetworkPhase = "locked";

  constructor(private readonly failCommand: string, private readonly stderr: string) {}
  async exec(command: SandboxCommand): Promise<SandboxCommandResult> {
    if (command.command === this.failCommand) return { exitCode: 1, stdout: "", stderr: this.stderr };
    return { exitCode: 0, stdout: "", stderr: "" };
  }
  async readFile(): Promise<string> { return ""; }
  async writeFile(): Promise<void> {}
  async setNetworkPhase(phase: SandboxNetworkPhase): Promise<void> { this.phase = phase; }
  async exportPatch(): Promise<SandboxPatch> { return { patch: "", status: "" }; }
  async snapshot(): Promise<SandboxSnapshot> { return { id: "snapshot" }; }
  async destroy(): Promise<void> {}
}

class Provider implements SandboxProvider {
  constructor(private readonly session: Session) {}
  async create(): Promise<SandboxSession> { return this.session; }
}

const repository: PinnedRepositoryArchive = {
  pinnedCommit: "a".repeat(40),
  archiveSha256: "c".repeat(64),
  archive: new TextEncoder().encode("archive"),
};

const patch = [
  "diff --git a/src/fix.ts b/src/fix.ts",
  "index 1111111..2222222 100644",
  "--- a/src/fix.ts",
  "+++ b/src/fix.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "",
].join("\n");

function input() {
  return {
    repository,
    harnessOutcome: { status: "completed" as const, limit: null, turnsUsed: 2, wallClockSeconds: 4, patch: { patch, status: " M src/fix.ts\n" } },
    evaluation: {
      referenceFiles: ["src/fix.ts"],
      referenceDiffLines: 2,
      hiddenFiles: [],
      commands: {
        install: "install",
        reproduction: "repro",
        reference: "reference",
        regression: "regression",
        build: "build",
        lint: "lint",
      },
    },
    result: {
      runId: "run-1",
      taskId: "task-1",
      difficulty: "easy" as const,
      split: "development" as const,
      runNumber: 1,
      instructionVersion: "phase0-bugfix-v1",
      configuration: { harness: "codex", harnessVersion: "0.90.0", model: "m", modelVersion: "v", modelSettings: {}, sandboxImage: "template" },
      safety: { canarySeenInOutput: false, connectionsOutsideAllowlist: false },
      cost: { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningTokens: 0, modelCostUsd: 0, sandboxSeconds: 0, sandboxCostUsd: 0, totalCostUsd: 0 },
    },
  };
}

describe("collector failure evidence", () => {
  it("marks an unpatched red baseline as an invalid task error", async () => {
    const writer = new Writer();
    const collector = new TypeScriptNodeCollector({
      sandboxProvider: new Provider(new Session("regression", "baseline suite is red")),
      baselineCache: new InMemoryBaselineSuiteCache(),
      resultWriter: writer,
    });

    const row = await collector.collect(input());
    expect(row.outcome.status).toBe("error");
    expect(row.collector).toMatchObject({
      taskValidity: "invalid",
      failure: { step: "baseline-regression", stderrTail: "baseline suite is red" },
    });
  });

  it("records the failing step and bounded stderr tail for collector errors", async () => {
    const writer = new Writer();
    const stderr = `${"x".repeat(5_000)}INSTALL_TAIL`;
    const collector = new TypeScriptNodeCollector({
      sandboxProvider: new Provider(new Session("install", stderr)),
      baselineCache: new InMemoryBaselineSuiteCache(),
      resultWriter: writer,
    });

    const row = await collector.collect(input());
    expect(row.outcome.status).toBe("error");
    expect(row.collector?.taskValidity).toBe("valid");
    expect(row.collector?.failure?.step).toBe("dependency-install");
    expect(row.collector?.failure?.stderrTail).toContain("INSTALL_TAIL");
    expect(row.collector?.failure?.stderrTail.length).toBeLessThanOrEqual(2_048);
  });
});

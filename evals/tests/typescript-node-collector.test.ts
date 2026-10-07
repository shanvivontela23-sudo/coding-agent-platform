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
  SandboxCreateRequest,
  SandboxNetworkPhase,
  SandboxPatch,
  SandboxProvider,
  SandboxSession,
  SandboxSnapshot,
} from "../src/sandbox/types.js";

function patchFile(path: string, body: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    "index 1111111..2222222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1 +1 @@",
    body,
    "",
  ].join("\n");
}

class FakeEvaluationSession implements SandboxSession {
  readonly id: string;
  readonly workspacePath = "/workspace/repo";
  readonly baselineCommitSha = "b".repeat(40);
  readonly phases: SandboxNetworkPhase[] = [];
  readonly commands: Array<{ command: SandboxCommand; phase: SandboxNetworkPhase }> = [];
  readonly writes: Array<{ path: string; phase: SandboxNetworkPhase }> = [];
  private phase: SandboxNetworkPhase = "locked";
  private reproductionRuns = 0;

  constructor(id: string) {
    this.id = id;
  }

  async exec(command: SandboxCommand): Promise<SandboxCommandResult> {
    this.commands.push({ command, phase: this.phase });
    if (command.command === "pnpm test:repro") {
      this.reproductionRuns += 1;
      return { exitCode: this.reproductionRuns === 1 ? 1 : 0, stdout: "", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  async readFile(): Promise<string> { return ""; }
  async writeFile(path: string): Promise<void> { this.writes.push({ path, phase: this.phase }); }
  async setNetworkPhase(phase: SandboxNetworkPhase): Promise<void> { this.phase = phase; this.phases.push(phase); }
  async exportPatch(): Promise<SandboxPatch> { return { patch: "", status: "" }; }
  async snapshot(): Promise<SandboxSnapshot> { return { id: "snapshot" }; }
  async destroy(): Promise<void> {}
}

class FakeProvider implements SandboxProvider {
  readonly requests: SandboxCreateRequest[] = [];
  readonly sessions: FakeEvaluationSession[] = [];
  async create(request: SandboxCreateRequest): Promise<SandboxSession> {
    this.requests.push(request);
    const session = new FakeEvaluationSession(`evaluation-${this.sessions.length + 1}`);
    this.sessions.push(session);
    return session;
  }
}

class MemoryWriter implements RunResultWriter {
  readonly rows: RunResult[] = [];
  async write(result: RunResult): Promise<void> { this.rows.push(result); }
}

const repository: PinnedRepositoryArchive = {
  pinnedCommit: "a".repeat(40), archiveSha256: "c".repeat(64), archive: new TextEncoder().encode("archive"),
};

function baseInput(patch: string) {
  return {
    repository,
    harnessOutcome: {
      status: "completed" as const, limit: null, turnsUsed: 4, wallClockSeconds: 12,
      patch: { patch, status: " M src/fix.ts\n M test/fix.test.ts\n" },
    },
    evaluation: {
      referenceFiles: ["src/fix.ts"], referenceDiffLines: 4,
      hiddenFiles: [{ path: ".benchmark-hidden/reference.test.ts", contents: "HIDDEN_SENTINEL" }],
      commands: {
        install: "pnpm install --frozen-lockfile", reproduction: "pnpm test:repro",
        reference: "pnpm test:reference", regression: "pnpm test:regression",
        build: "pnpm build", lint: "pnpm lint",
      },
    },
    result: {
      runId: "run-1", taskId: "task-1", difficulty: "easy" as const,
      split: "development" as const, runNumber: 1, instructionVersion: "v1",
      configuration: {
        harness: "codex", harnessVersion: "0.90.0", model: "primary-model",
        modelVersion: "2026-10-01", modelSettings: {}, sandboxImage: "ts-node-v1",
      },
      safety: { canarySeenInOutput: false, connectionsOutsideAllowlist: false },
      cost: {
        inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0,
        reasoningTokens: 0, modelCostUsd: 0, sandboxSeconds: 0, sandboxCostUsd: 0, totalCostUsd: 0,
      },
    },
  };
}

describe("TypeScript/Node collector", () => {
  it("replays and runs every evaluation command in a second sandbox that becomes offline after install", async () => {
    const provider = new FakeProvider();
    const writer = new MemoryWriter();
    const collector = new TypeScriptNodeCollector({ sandboxProvider: provider, baselineCache: new InMemoryBaselineSuiteCache(), resultWriter: writer });
    const patch = `${patchFile("src/fix.ts", "-old\n+new")}${patchFile("test/fix.test.ts", "-expect(old)\n+expect(new)")}`;
    const result = await collector.collect(baseInput(patch));
    expect(provider.requests).toHaveLength(1);
    expect(provider.sessions[0]?.phases).toEqual(["dependency-setup", "offline"]);
    expect(provider.sessions[0]?.commands.find(({ command }) => command.command === "pnpm install --frozen-lockfile")?.phase).toBe("dependency-setup");
    expect(provider.sessions[0]?.commands.filter(({ command }) => command.command !== "pnpm install --frozen-lockfile").every(({ phase }) => phase === "offline")).toBe(true);
    expect(provider.sessions[0]?.writes.every(({ phase }) => phase === "offline")).toBe(true);
    expect(result.automatic).toMatchObject({ reproduction: true, referenceTests: true, regressionTests: true, build: true, lint: true, scope: "in-scope" });
    expect(result.outcome).toMatchObject({ status: "completed", limit: null, turnsUsed: 4, wallClockSeconds: 12 });
    expect(writer.rows).toHaveLength(1);
    expect(JSON.stringify(writer.rows[0])).not.toContain("HIDDEN_SENTINEL");
  });

  it("requires test-only failure then full-patch pass, and returns reproduction false when no test changed", async () => {
    const provider = new FakeProvider();
    const collector = new TypeScriptNodeCollector({ sandboxProvider: provider, baselineCache: new InMemoryBaselineSuiteCache(), resultWriter: new MemoryWriter() });
    const result = await collector.collect(baseInput(patchFile("src/fix.ts", "-old\n+new")));
    expect(result.automatic.reproduction).toBe(false);
    expect(provider.sessions[0]?.commands.filter(({ command }) => command.command === "pnpm test:repro")).toHaveLength(0);
  });

  it("runs the unpatched regression suite once per task/pinned tree and reuses the cached baseline", async () => {
    const provider = new FakeProvider();
    const cache = new InMemoryBaselineSuiteCache();
    const collector = new TypeScriptNodeCollector({ sandboxProvider: provider, baselineCache: cache, resultWriter: new MemoryWriter() });
    const patch = `${patchFile("src/fix.ts", "-old\n+new")}${patchFile("test/fix.test.ts", "-expect(old)\n+expect(new)")}`;
    await collector.collect(baseInput(patch));
    await collector.collect({ ...baseInput(patch), result: { ...baseInput(patch).result, runId: "run-2", runNumber: 2 } });
    expect(provider.sessions.flatMap((session) => session.commands.filter(({ command }) => command.command === "pnpm test:regression"))).toHaveLength(3);
  });

  it("rejects hidden evaluation files outside the dedicated hidden namespace", async () => {
    const provider = new FakeProvider();
    const writer = new MemoryWriter();
    const collector = new TypeScriptNodeCollector({ sandboxProvider: provider, baselineCache: new InMemoryBaselineSuiteCache(), resultWriter: writer });
    const input = baseInput(patchFile("src/fix.ts", "-old\n+new"));
    const result = await collector.collect({ ...input, evaluation: { ...input.evaluation, hiddenFiles: [{ path: "src/fix.ts", contents: "must-not-overwrite-source" }] } });
    expect(result.outcome.status).toBe("error");
    expect(provider.sessions[0]?.writes.some(({ path }) => path === "src/fix.ts")).toBe(false);
    expect(writer.rows).toHaveLength(1);
  });

  it("writes asked/no-patch outcomes without creating an evaluator sandbox", async () => {
    const provider = new FakeProvider();
    const writer = new MemoryWriter();
    const collector = new TypeScriptNodeCollector({ sandboxProvider: provider, baselineCache: new InMemoryBaselineSuiteCache(), resultWriter: writer });
    const input = baseInput("");
    const result = await collector.collect({
      ...input,
      harnessOutcome: { ...input.harnessOutcome, status: "asked", turnsUsed: 2, patch: { patch: "", status: "" } },
    });
    expect(provider.requests).toHaveLength(0);
    expect(result.outcome).toMatchObject({ status: "asked", turnsUsed: 2 });
    expect(result.automatic).toMatchObject({ reproduction: false, referenceTests: false, regressionTests: false, build: false, lint: false });
    expect(writer.rows).toHaveLength(1);
  });
});

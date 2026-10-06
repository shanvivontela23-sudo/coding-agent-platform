import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runResultSchema } from "../src/domain/run-result.js";

const collectorModulePath: string = "../src/collector/index.js";

type CollectorModule = {
  buildCollectedRunResult: (input: Record<string, unknown>) => unknown;
  FileRunResultWriter: new (options: { rootDir: string }) => {
    write(row: unknown): Promise<string>;
  };
};

async function loadCollector(): Promise<CollectorModule> {
  return (await import(/* @vite-ignore */ collectorModulePath)) as CollectorModule;
}

function fixtureInput() {
  return {
    task: {
      id: "task-1",
      difficulty: "medium",
      split: "held-out",
    },
    run: {
      runId: "run-1",
      runNumber: 1,
      instructionVersion: "instructions-v1",
      configuration: {
        harness: "claude-code",
        harnessVersion: "2.1.300",
        model: "model-1",
        modelVersion: "model-1-2026-10-01",
        modelSettings: {},
        sandboxImage: "e2b-ts-node-v1",
      },
    },
    outcome: {
      status: "limit-hit",
      limit: "turns",
      turnsUsed: 5,
      wallClockSeconds: 42,
    },
    automatic: {
      reproduction: true,
      referenceTests: true,
      regressionTests: true,
      build: true,
      lint: true,
      scope: "in-scope",
      filesChanged: 2,
      diffLines: 12,
    },
    safety: {
      canarySeenInOutput: false,
      connectionsOutsideAllowlist: false,
    },
    cost: {
      inputTokens: 100,
      cachedInputTokens: 20,
      cacheWriteInputTokens: 0,
      outputTokens: 50,
      reasoningTokens: 10,
      modelCostUsd: 0.25,
      sandboxSeconds: 90,
      sandboxCostUsd: 0.05,
      totalCostUsd: 0.3,
    },
  };
}

describe("collector result rows", () => {
  it("copies adapter outcome metadata into a validated TypeScript/Node RunResult", async () => {
    const { buildCollectedRunResult } = await loadCollector();
    const row = runResultSchema.parse(buildCollectedRunResult(fixtureInput()));

    expect(row.stack).toBe("typescript-node");
    expect(row.outcome).toEqual({
      status: "limit-hit",
      limit: "turns",
      turnsUsed: 5,
      wallClockSeconds: 42,
    });
    expect(row.automatic.reproduction).toBe(true);
    expect(row.developer).toBeNull();
    expect(row.reviewer).toBeNull();
  });

  it("writes each validated row atomically as one host-side result record", async () => {
    const { buildCollectedRunResult, FileRunResultWriter } = await loadCollector();
    const root = await mkdtemp(join(tmpdir(), "coding-agent-result-row-"));
    try {
      const row = buildCollectedRunResult(fixtureInput());
      const writer = new FileRunResultWriter({ rootDir: root });
      const path = await writer.write(row);
      const persisted = JSON.parse(await readFile(path, "utf8")) as unknown;

      expect(runResultSchema.parse(persisted)).toEqual(runResultSchema.parse(row));
      expect((await readdir(root)).some((name) => name.endsWith(".tmp"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

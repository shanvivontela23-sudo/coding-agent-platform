import { describe, expect, it } from "vitest";

const collectorModulePath: string = "../src/collector/index.js";

type Observation = {
  readonly tests: readonly {
    readonly id: string;
    readonly status: "passed" | "failed" | "skipped";
  }[];
};

type CollectorModule = {
  scoreRegressionAgainstBaseline: (baseline: Observation, patched: Observation) => boolean;
};

async function loadCollector(): Promise<CollectorModule> {
  return (await import(/* @vite-ignore */ collectorModulePath)) as CollectorModule;
}

describe("regression scoring against pristine baseline", () => {
  it("does not penalize a pre-existing failure that remains unchanged", async () => {
    const { scoreRegressionAgainstBaseline } = await loadCollector();
    const baseline: Observation = {
      tests: [
        { id: "stable", status: "passed" },
        { id: "already-broken", status: "failed" },
      ],
    };
    const patched: Observation = {
      tests: [
        { id: "stable", status: "passed" },
        { id: "already-broken", status: "failed" },
      ],
    };

    expect(scoreRegressionAgainstBaseline(baseline, patched)).toBe(true);
  });

  it("fails when a previously passing test fails or disappears", async () => {
    const { scoreRegressionAgainstBaseline } = await loadCollector();
    const baseline: Observation = {
      tests: [
        { id: "stable-a", status: "passed" },
        { id: "stable-b", status: "passed" },
      ],
    };

    expect(
      scoreRegressionAgainstBaseline(baseline, {
        tests: [
          { id: "stable-a", status: "failed" },
          { id: "stable-b", status: "passed" },
        ],
      }),
    ).toBe(false);
    expect(
      scoreRegressionAgainstBaseline(baseline, {
        tests: [{ id: "stable-a", status: "passed" }],
      }),
    ).toBe(false);
  });
});

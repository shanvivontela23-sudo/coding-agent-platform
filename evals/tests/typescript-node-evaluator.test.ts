import { describe, expect, it } from "vitest";

const collectorModulePath: string = "../src/collector/index.js";

type Observation = {
  readonly tests: readonly {
    readonly id: string;
    readonly status: "passed" | "failed" | "skipped";
  }[];
};

type EvaluationResult = {
  readonly reproduction: boolean;
  readonly referenceTests: boolean;
  readonly regressionTests: boolean;
  readonly build: boolean;
  readonly lint: boolean;
  readonly scope: "in-scope" | "flagged" | "violation";
  readonly filesChanged: number;
  readonly diffLines: number;
};

type CollectorModule = {
  evaluateTypeScriptNodePatch: (options: Record<string, unknown>) => Promise<EvaluationResult>;
};

async function loadCollector(): Promise<CollectorModule> {
  return (await import(/* @vite-ignore */ collectorModulePath)) as CollectorModule;
}

class FakeBaselineCache {
  readonly values = new Map<string, Observation>();
  getCalls = 0;
  setCalls = 0;

  async get(key: string): Promise<Observation | null> {
    this.getCalls += 1;
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: Observation): Promise<void> {
    this.setCalls += 1;
    this.values.set(key, value);
  }
}

class FakeEvaluationSession {
  readonly workspacePath = "/workspace/repo";
  readonly baselineCommitSha = "b".repeat(40);
  readonly phases: string[] = [];
  readonly commands: string[] = [];
  readonly writes: Array<{ path: string; phase: string | null }> = [];
  destroyed = 0;
  currentPhase: string | null = null;
  currentObservation: Observation | null = null;
  reproductionCalls = 0;
  regressionCalls = 0;

  constructor(
    readonly id: string,
    private readonly regressionObservations: readonly Observation[],
    private readonly nameStatus = "M\tsrc/fix.ts\nA\ttests/fix.test.ts\n",
    private readonly numstat = "4\t2\tsrc/fix.ts\n3\t0\ttests/fix.test.ts\n",
  ) {}

  async exec(input: { command: string }): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const command = input.command;
    this.commands.push(command);

    if (command === "INSTALL_DEPS") return { exitCode: 0, stdout: "", stderr: "" };
    if (command.includes("git status --porcelain")) return { exitCode: 0, stdout: "", stderr: "" };
    if (command.includes("git diff --numstat --no-renames")) {
      return { exitCode: 0, stdout: this.numstat, stderr: "" };
    }
    if (command.includes("git diff --name-status --no-renames")) {
      return { exitCode: 0, stdout: this.nameStatus, stderr: "" };
    }
    if (command.includes("git apply")) return { exitCode: 0, stdout: "", stderr: "" };
    if (command.includes("git reset --hard")) return { exitCode: 0, stdout: "", stderr: "" };
    if (command.startsWith("RUN_CHANGED_TESTS")) {
      this.reproductionCalls += 1;
      return {
        exitCode: this.reproductionCalls % 2 === 1 ? 1 : 0,
        stdout: "",
        stderr: "",
      };
    }
    if (command === "RUN_REGRESSION") {
      const observation = this.regressionObservations[this.regressionCalls];
      this.regressionCalls += 1;
      if (!observation) throw new Error("unexpected regression command");
      this.currentObservation = observation;
      const failed = observation.tests.some((test) => test.status === "failed");
      return { exitCode: failed ? 1 : 0, stdout: "", stderr: "" };
    }
    if (command === "RUN_REFERENCE" || command === "RUN_BUILD" || command === "RUN_LINT") {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  async readFile(path: string): Promise<string> {
    if (path === ".coding-agent-eval/regression.json" && this.currentObservation) {
      return JSON.stringify(this.currentObservation);
    }
    return "";
  }

  async writeFile(path: string): Promise<void> {
    this.writes.push({ path, phase: this.currentPhase });
  }

  async setNetworkPhase(phase: string): Promise<void> {
    this.currentPhase = phase;
    this.phases.push(phase);
  }

  async exportPatch() {
    return { patch: "", status: "" };
  }

  async snapshot() {
    return { id: "snapshot" };
  }

  async destroy(): Promise<void> {
    this.destroyed += 1;
  }
}

const baselineObservation: Observation = {
  tests: [
    { id: "tests/fix.test.ts > bug", status: "passed" },
    { id: "tests/other.test.ts > healthy", status: "passed" },
  ],
};

const patchedObservation: Observation = {
  tests: [
    { id: "tests/fix.test.ts > bug", status: "passed" },
    { id: "tests/other.test.ts > healthy", status: "passed" },
  ],
};

function evaluationPlan() {
  return {
    version: "typescript-node-v1",
    dependencyInstallCommand: "INSTALL_DEPS",
    reproductionCommandPrefix: "RUN_CHANGED_TESTS",
    regressionCommand: "RUN_REGRESSION",
    regressionObservationPath: ".coding-agent-eval/regression.json",
    referenceCommand: "RUN_REFERENCE",
    buildCommand: "RUN_BUILD",
    lintCommand: "RUN_LINT",
    hiddenFiles: [
      {
        path: ".coding-agent-hidden/reference.test.ts",
        content: "HIDDEN_TEST_CONTENT",
      },
    ],
    protectedPaths: [],
  };
}

function baseOptions(provider: unknown, cache: unknown) {
  return {
    sandboxProvider: provider,
    baselineCache: cache,
    harnessSandboxId: "harness-sandbox",
    taskId: "task-1",
    repository: {
      pinnedCommit: "a".repeat(40),
      archiveSha256: "b".repeat(64),
      archive: new Uint8Array(),
    },
    gatewayUrl: "https://gateway.example.com",
    patch: "synthetic full binary-capable patch",
    referenceFiles: ["src/fix.ts"],
    referenceDiffLines: 5,
    evaluationPlan: evaluationPlan(),
  };
}

describe("TypeScript/Node second-sandbox evaluator", () => {
  it("installs with registry access, goes fully offline, proves reproduction, and caches the pristine baseline", async () => {
    const { evaluateTypeScriptNodePatch } = await loadCollector();
    const first = new FakeEvaluationSession("eval-1", [baselineObservation, patchedObservation]);
    const second = new FakeEvaluationSession("eval-2", [patchedObservation]);
    const sessions = [first, second];
    const createCalls: unknown[] = [];
    const provider = {
      create: async (request: unknown) => {
        createCalls.push(request);
        const session = sessions.shift();
        if (!session) throw new Error("no fake evaluation sandbox left");
        return session;
      },
    };
    const cache = new FakeBaselineCache();

    const firstResult = await evaluateTypeScriptNodePatch(baseOptions(provider, cache));
    const secondResult = await evaluateTypeScriptNodePatch(baseOptions(provider, cache));

    expect(firstResult).toEqual({
      reproduction: true,
      referenceTests: true,
      regressionTests: true,
      build: true,
      lint: true,
      scope: "in-scope",
      filesChanged: 2,
      diffLines: 9,
    });
    expect(secondResult).toEqual(firstResult);
    expect(createCalls).toHaveLength(2);
    expect(first.id).not.toBe("harness-sandbox");
    expect(second.id).not.toBe("harness-sandbox");
    expect(first.phases).toEqual(["dependency-setup", "evaluation"]);
    expect(second.phases).toEqual(["dependency-setup", "evaluation"]);
    expect(first.phases).not.toContain("coding");
    expect(first.phases).not.toContain("testing");
    expect(first.commands[0]).toBe("INSTALL_DEPS");
    expect(first.commands.some((command) => command.includes("git diff --numstat --no-renames"))).toBe(true);
    expect(first.commands.some((command) => command.includes("--include='tests/fix.test.ts'"))).toBe(true);
    expect(first.reproductionCalls).toBe(2);
    expect(second.reproductionCalls).toBe(2);
    expect(first.regressionCalls).toBe(2);
    expect(second.regressionCalls).toBe(1);
    expect(cache.setCalls).toBe(1);
    expect(first.writes.find(({ path }) => path.includes("reference.test.ts"))?.phase).toBe("evaluation");
    expect(first.destroyed).toBe(1);
    expect(second.destroyed).toBe(1);
  });

  it("scores reproduction false and does not run changed tests when the harness changed no tests", async () => {
    const { evaluateTypeScriptNodePatch } = await loadCollector();
    const session = new FakeEvaluationSession(
      "eval-no-tests",
      [baselineObservation, patchedObservation],
      "M\tsrc/fix.ts\n",
      "2\t1\tsrc/fix.ts\n",
    );
    const provider = { create: async () => session };
    const cache = new FakeBaselineCache();

    const result = await evaluateTypeScriptNodePatch(baseOptions(provider, cache));

    expect(result.reproduction).toBe(false);
    expect(session.reproductionCalls).toBe(0);
    expect(result.scope).toBe("in-scope");
  });
});

import { posix } from "node:path";
import type { RunResult } from "../domain/run-result.js";
import { runResultSchema } from "../domain/run-result.js";
import type { HarnessRunOutcome } from "../harness/types.js";
import type {
  PinnedRepositoryArchive,
  SandboxCommandResult,
  SandboxProvider,
  SandboxSession,
} from "../sandbox/types.js";
import {
  baselineSuiteCacheKey,
  type BaselineSuiteCache,
  type BaselineSuiteResult,
} from "./baseline-cache.js";
import type { RunResultWriter } from "./result-writer.js";
import { analyzePatchScope } from "./scope.js";

export type TypeScriptNodeEvaluationCommands = {
  readonly install: string;
  readonly reproduction: string;
  readonly reference: string;
  readonly regression: string;
  readonly build: string;
  readonly lint: string;
};

export type HiddenEvaluationFile = {
  readonly path: string;
  readonly contents: string | ArrayBuffer;
};

export type TypeScriptNodeEvaluationSpec = {
  readonly referenceFiles: readonly string[];
  readonly referenceDiffLines: number;
  readonly hiddenFiles: readonly HiddenEvaluationFile[];
  readonly commands: TypeScriptNodeEvaluationCommands;
  readonly extraDependencyHosts?: readonly string[];
  readonly commandTimeoutMs?: number;
};

type ResultSeed = Pick<
  RunResult,
  | "runId"
  | "taskId"
  | "difficulty"
  | "split"
  | "runNumber"
  | "instructionVersion"
  | "configuration"
  | "safety"
  | "cost"
>;

type CollectorEvidence = NonNullable<RunResult["collector"]>;

export type TypeScriptNodeCollectInput = {
  readonly repository: PinnedRepositoryArchive;
  readonly harnessOutcome: HarnessRunOutcome;
  readonly evaluation: TypeScriptNodeEvaluationSpec;
  readonly result: ResultSeed;
};

export type TypeScriptNodeCollectorOptions = {
  readonly sandboxProvider: SandboxProvider;
  readonly baselineCache: BaselineSuiteCache;
  readonly resultWriter: RunResultWriter;
};

const fullPatchPath = ".benchmark-full.patch";
const testPatchPath = ".benchmark-test-only.patch";
const hiddenRoot = ".benchmark-hidden";
const defaultCommandTimeoutMs = 10 * 60_000;
const offlineGatewayPlaceholder = "https://offline.invalid";
const stderrTailLimit = 2_048;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function restoreCommand(baselineCommitSha: string): string {
  return [
    `git reset --hard ${shellQuote(baselineCommitSha)}`,
    "git clean -fdx -e node_modules/ -e .pnpm-store/",
  ].join(" && ");
}

function applyPatchCommand(path: string): string {
  return `git apply --binary --whitespace=nowarn ${shellQuote(path)}`;
}

async function run(
  session: SandboxSession,
  command: string,
  timeoutMs: number,
): Promise<SandboxCommandResult> {
  return await session.exec({ command, cwd: session.workspacePath, timeoutMs });
}

function tail(value: string): string {
  return value.slice(-stderrTailLimit);
}

function errorTail(error: unknown): string {
  if (error instanceof Error) return tail(error.message);
  if (typeof error === "string") return tail(error);
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    const text = [record.stderr, record.error, record.message]
      .filter((value): value is string => typeof value === "string")
      .join("\n");
    if (text) return tail(text);
  }
  return "collector error";
}

function automaticFailure(scope: ReturnType<typeof analyzePatchScope>) {
  return {
    reproduction: false,
    referenceTests: false,
    regressionTests: false,
    build: false,
    lint: false,
    scope: scope.scope,
    filesChanged: scope.filesChanged,
    diffLines: scope.diffLines,
  } as const;
}

function healthyCollectorEvidence(): CollectorEvidence {
  return { taskValidity: "valid", failure: null };
}

function failureEvidence(
  step: string,
  stderr: string,
  taskValidity: "valid" | "invalid" = "valid",
): CollectorEvidence {
  return {
    taskValidity,
    failure: { step, stderrTail: tail(stderr || "collector step failed") },
  };
}

function resultRow(
  input: TypeScriptNodeCollectInput,
  automatic: RunResult["automatic"],
  options: {
    readonly statusOverride?: "error";
    readonly collector?: CollectorEvidence;
  } = {},
): RunResult {
  return runResultSchema.parse({
    ...input.result,
    stack: "typescript-node",
    outcome: {
      status: options.statusOverride ?? input.harnessOutcome.status,
      limit: options.statusOverride ? null : input.harnessOutcome.limit,
      turnsUsed: input.harnessOutcome.turnsUsed,
      wallClockSeconds: input.harnessOutcome.wallClockSeconds,
    },
    automatic,
    collector: options.collector ?? healthyCollectorEvidence(),
    developer: null,
    reviewer: null,
  });
}

function normalizedHiddenPath(path: string): string {
  const normalized = posix.normalize(path);
  if (
    !path.trim() ||
    path.startsWith("/") ||
    normalized === hiddenRoot ||
    !normalized.startsWith(`${hiddenRoot}/`) ||
    normalized.split("/").includes("..")
  ) {
    throw new Error(`hidden evaluation files must stay under ${hiddenRoot}/: ${path}`);
  }
  return normalized;
}

async function writeHiddenFiles(
  session: SandboxSession,
  files: readonly HiddenEvaluationFile[],
  timeoutMs: number,
): Promise<void> {
  for (const file of files) {
    const path = normalizedHiddenPath(file.path);
    const parent = posix.dirname(path);
    const mkdir = await run(session, `mkdir -p ${shellQuote(parent)}`, timeoutMs);
    if (mkdir.exitCode !== 0) throw new Error(`failed to create hidden evaluation directory: ${tail(mkdir.stderr)}`);
    await session.writeFile(path, file.contents);
  }
}

async function restorePinnedTree(session: SandboxSession, timeoutMs: number): Promise<boolean> {
  return (await run(session, restoreCommand(session.baselineCommitSha), timeoutMs)).exitCode === 0;
}

async function applyPatch(
  session: SandboxSession,
  path: string,
  patch: string,
  timeoutMs: number,
): Promise<boolean> {
  await session.writeFile(path, patch);
  return (await run(session, applyPatchCommand(path), timeoutMs)).exitCode === 0;
}

function regressionMatchesBaseline(
  baseline: BaselineSuiteResult,
  patched: SandboxCommandResult,
): boolean {
  return baseline.exitCode === 0 && patched.exitCode === 0;
}

export class TypeScriptNodeCollector {
  private readonly sandboxProvider: SandboxProvider;
  private readonly baselineCache: BaselineSuiteCache;
  private readonly resultWriter: RunResultWriter;

  constructor(options: TypeScriptNodeCollectorOptions) {
    this.sandboxProvider = options.sandboxProvider;
    this.baselineCache = options.baselineCache;
    this.resultWriter = options.resultWriter;
  }

  async collect(input: TypeScriptNodeCollectInput): Promise<RunResult> {
    const scope = analyzePatchScope(input.harnessOutcome.patch.patch, {
      referenceFiles: input.evaluation.referenceFiles,
      referenceDiffLines: input.evaluation.referenceDiffLines,
    });
    if (!input.harnessOutcome.patch.patch.trim()) {
      const row = resultRow(input, automaticFailure(scope));
      await this.resultWriter.write(row);
      return row;
    }

    const timeoutMs = input.evaluation.commandTimeoutMs ?? defaultCommandTimeoutMs;
    let session: SandboxSession | null = null;
    let activeStep = "evaluation-sandbox-create";
    try {
      session = await this.sandboxProvider.create({
        taskId: `${input.result.taskId}:collector`,
        repository: input.repository,
        gatewayUrl: offlineGatewayPlaceholder,
        ...(input.evaluation.extraDependencyHosts ? { extraDependencyHosts: input.evaluation.extraDependencyHosts } : {}),
      });

      activeStep = "dependency-install";
      await session.setNetworkPhase("dependency-setup");
      const install = await run(session, input.evaluation.commands.install, timeoutMs);
      if (install.exitCode !== 0) {
        const row = resultRow(input, automaticFailure(scope), {
          statusOverride: "error",
          collector: failureEvidence(activeStep, install.stderr),
        });
        await this.resultWriter.write(row);
        return row;
      }

      activeStep = "offline-transition";
      await session.setNetworkPhase("offline");

      const baselineKey = baselineSuiteCacheKey({
        taskId: input.result.taskId,
        pinnedCommit: input.repository.pinnedCommit,
        regressionCommand: input.evaluation.commands.regression,
      });
      activeStep = "baseline-regression";
      let baseline = await this.baselineCache.get(baselineKey);
      if (!baseline) {
        const baselineRun = await run(session, input.evaluation.commands.regression, timeoutMs);
        baseline = {
          exitCode: baselineRun.exitCode,
          stderrTail: tail(baselineRun.stderr),
        };
        await this.baselineCache.set(baselineKey, baseline);
      }
      if (baseline.exitCode !== 0) {
        const row = resultRow(input, automaticFailure(scope), {
          statusOverride: "error",
          collector: failureEvidence(
            activeStep,
            baseline.stderrTail ?? "cached unpatched regression baseline exited non-zero",
            "invalid",
          ),
        });
        await this.resultWriter.write(row);
        return row;
      }

      let reproduction = false;
      if (scope.testOnlyPatch.trim()) {
        activeStep = "restore-before-reproduction";
        if (!(await restorePinnedTree(session, timeoutMs))) throw new Error("failed to restore pinned tree before reproduction probe");
        activeStep = "test-only-patch-apply";
        const testsApplied = await applyPatch(session, testPatchPath, scope.testOnlyPatch, timeoutMs);
        if (testsApplied) {
          activeStep = "test-only-reproduction";
          const testOnlyRun = await run(session, input.evaluation.commands.reproduction, timeoutMs);
          if (testOnlyRun.exitCode !== 0) {
            activeStep = "restore-before-full-reproduction";
            if (!(await restorePinnedTree(session, timeoutMs))) throw new Error("failed to restore pinned tree before full patch replay");
            activeStep = "full-reproduction-patch-apply";
            const fullAppliedForReproduction = await applyPatch(session, fullPatchPath, input.harnessOutcome.patch.patch, timeoutMs);
            if (fullAppliedForReproduction) {
              activeStep = "full-reproduction";
              const fullRun = await run(session, input.evaluation.commands.reproduction, timeoutMs);
              reproduction = fullRun.exitCode === 0;
            }
          }
        }
      }

      activeStep = "restore-before-scoring";
      if (!(await restorePinnedTree(session, timeoutMs))) throw new Error("failed to restore pinned tree before scoring");
      activeStep = "full-scoring-patch-apply";
      const fullApplied = await applyPatch(session, fullPatchPath, input.harnessOutcome.patch.patch, timeoutMs);
      if (!fullApplied) {
        const row = resultRow(input, automaticFailure(scope));
        await this.resultWriter.write(row);
        return row;
      }

      activeStep = "hidden-reference-material";
      await writeHiddenFiles(session, input.evaluation.hiddenFiles, timeoutMs);
      activeStep = "reference-tests";
      const reference = await run(session, input.evaluation.commands.reference, timeoutMs);
      activeStep = "patched-regression";
      const regression = await run(session, input.evaluation.commands.regression, timeoutMs);
      activeStep = "build";
      const build = await run(session, input.evaluation.commands.build, timeoutMs);
      activeStep = "lint";
      const lint = await run(session, input.evaluation.commands.lint, timeoutMs);
      const row = resultRow(input, {
        reproduction,
        referenceTests: reference.exitCode === 0,
        regressionTests: regressionMatchesBaseline(baseline, regression),
        build: build.exitCode === 0,
        lint: lint.exitCode === 0,
        scope: scope.scope,
        filesChanged: scope.filesChanged,
        diffLines: scope.diffLines,
      });
      await this.resultWriter.write(row);
      return row;
    } catch (error) {
      const row = resultRow(input, automaticFailure(scope), {
        statusOverride: "error",
        collector: failureEvidence(activeStep, errorTail(error)),
      });
      await this.resultWriter.write(row);
      return row;
    } finally {
      await session?.destroy().catch(() => undefined);
    }
  }
}

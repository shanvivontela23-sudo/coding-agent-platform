import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  FileBaselineSuiteCache,
  FileRunResultWriter,
  TypeScriptNodeCollector,
  type RunResultWriter,
} from "../collector/index.js";
import type { RunResult } from "../domain/run-result.js";
import { ClaudeCodeHarnessRunner } from "../harness/index.js";
import {
  PHASE0_INSTRUCTION_VERSION,
  Phase0RunOrchestrator,
  sandboxLifetimeMs,
} from "../orchestrator/index.js";
import { E2BSandboxProvider } from "../sandbox/e2b-provider.js";
import { CLAUDE_CODE_VERSION } from "../../sandbox-templates/typescript-node/template.js";
import { requireLiveSmoke } from "../../smoke/contracts.js";
import { gatewayUrlFromHostname } from "../../smoke/local-tunnel.js";
import { finishAndReconcileLocalRun, startLocalHttpRun } from "./http-run-control.js";
import { MeteredSandboxProvider } from "./metered-sandbox-provider.js";
import { singleClaudeTaskSpecSchema } from "./single-task-spec.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the one-task Claude run`);
  return value;
}

class NoopWriter implements RunResultWriter {
  async write(): Promise<void> {}
}

async function ownedArrayBuffer(path: string): Promise<ArrayBuffer> {
  return Uint8Array.from(await readFile(resolve(path))).buffer;
}

async function main(): Promise<void> {
  requireLiveSmoke();
  const specPath = resolve(required("SINGLE_TASK_SPEC_PATH"));
  const spec = singleClaudeTaskSpecSchema.parse(JSON.parse(await readFile(specPath, "utf8")) as unknown);
  const repository = {
    pinnedCommit: spec.repository.pinnedCommit,
    archiveSha256: spec.repository.archiveSha256,
    archive: new Uint8Array(await readFile(resolve(spec.repository.archivePath))),
  };
  const hiddenFiles = await Promise.all(spec.hiddenFiles.map(async (file) => ({
    path: file.path,
    contents: await ownedArrayBuffer(file.sourcePath),
  })));

  const hostname = required("GATEWAY_HOSTNAME");
  const gatewayUrl = gatewayUrlFromHostname(hostname);
  const stateDir = resolve(process.env.LOCAL_GATEWAY_STATE_DIR ?? ".local/gateway-state");
  const litellmBaseUrl = process.env.SMOKE_LITELLM_BASE_URL?.trim() || "http://127.0.0.1:4000";
  const codingLifetimeMs = sandboxLifetimeMs({ setupTimeoutMs: spec.setupTimeoutMs, runTimeoutMs: spec.runTimeoutMs });
  const evaluatorLifetimeMs = spec.evaluatorCommandTimeoutMs * 8 + 5 * 60_000;
  const templateId = required("E2B_TEMPLATE_ID");

  process.stdout.write(`Estimated maximum model spend before run: $${spec.spendCapUsd.toFixed(2)} (authorized run cap)\n`);
  const local = await startLocalHttpRun({
    stateDir,
    litellmBaseUrl,
    litellmAdminToken: required("LITELLM_MASTER_KEY"),
    signingSecret: required("MODEL_GATEWAY_RUN_TOKEN_SECRET"),
    allowedModels: [spec.model],
    spendCapUsd: spec.spendCapUsd,
    ttlMs: codingLifetimeMs + 30 * 60_000,
    runId: `task-${spec.taskId}-${Date.now()}`,
  });

  const e2bProvider = new E2BSandboxProvider({
    apiKey: required("E2B_API_KEY"),
    defaultTemplate: templateId,
    defaultTimeoutMs: Math.max(codingLifetimeMs, evaluatorLifetimeMs),
  });
  const sandboxProvider = new MeteredSandboxProvider(e2bProvider, {
    sandboxUsdPerSecond: spec.sandboxUsdPerSecond,
  });
  const harness = new ClaudeCodeHarnessRunner({ version: CLAUDE_CODE_VERSION });
  const orchestrator = new Phase0RunOrchestrator({
    sandboxProvider,
    liveConfig: { e2bTemplateId: templateId },
  });

  const harnessOutcome = await orchestrator.run({
    taskId: spec.taskId,
    repository,
    gatewayUrl,
    runToken: local.token,
    ticketText: spec.ticketText,
    model: spec.model,
    maxTurns: spec.maxTurns,
    timeoutMs: spec.runTimeoutMs,
    setupTimeoutMs: spec.setupTimeoutMs,
    dependencySetupCommand: spec.dependencySetupCommand,
    ...(spec.extraDependencyHosts ? { extraDependencyHosts: spec.extraDependencyHosts } : {}),
    harness,
  });

  const resultRoot = resolve(process.env.EVAL_RESULTS_DIR ?? "evals/results/runs");
  const collector = new TypeScriptNodeCollector({
    sandboxProvider,
    baselineCache: new FileBaselineSuiteCache(resolve(process.env.EVAL_BASELINE_CACHE_DIR ?? "evals/results/baseline-cache")),
    resultWriter: new NoopWriter(),
  });
  const collected = await collector.collect({
    repository,
    harnessOutcome,
    evaluation: {
      referenceFiles: spec.referenceFiles,
      referenceDiffLines: spec.referenceDiffLines,
      hiddenFiles,
      commands: spec.commands,
      commandTimeoutMs: spec.evaluatorCommandTimeoutMs,
      ...(spec.extraDependencyHosts ? { extraDependencyHosts: spec.extraDependencyHosts } : {}),
    },
    result: {
      runId: local.run.runId,
      taskId: spec.taskId,
      difficulty: spec.difficulty,
      split: spec.split,
      runNumber: spec.runNumber,
      instructionVersion: PHASE0_INSTRUCTION_VERSION,
      configuration: {
        harness: "claude-code",
        harnessVersion: CLAUDE_CODE_VERSION,
        model: spec.model,
        modelVersion: spec.modelVersion,
        modelSettings: {},
        sandboxImage: templateId,
      },
      safety: { canarySeenInOutput: false, connectionsOutsideAllowlist: false },
      cost: {
        inputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        modelCostUsd: 0,
        sandboxSeconds: 0,
        sandboxCostUsd: 0,
        totalCostUsd: 0,
      },
    },
  });

  const actualModelSpendUsd = await finishAndReconcileLocalRun(local);
  const calls = await local.callStore.listCalls(local.run.runId);
  const usage = calls.reduce((sum, call) => ({
    inputTokens: sum.inputTokens + call.usage.inputTokens,
    cachedInputTokens: sum.cachedInputTokens + call.usage.cachedInputTokens,
    cacheWriteInputTokens: sum.cacheWriteInputTokens + call.usage.cacheWriteInputTokens,
    outputTokens: sum.outputTokens + call.usage.outputTokens,
    reasoningTokens: sum.reasoningTokens + call.usage.reasoningTokens,
  }), { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningTokens: 0 });
  const sandboxCost = sandboxProvider.cost();
  const finalResult: RunResult = {
    ...collected,
    cost: {
      ...collected.cost,
      ...usage,
      modelCostUsd: actualModelSpendUsd,
      sandboxSeconds: sandboxCost.sandboxSeconds,
      sandboxCostUsd: sandboxCost.sandboxCostUsd,
      totalCostUsd: actualModelSpendUsd + sandboxCost.sandboxCostUsd,
    },
  };
  await new FileRunResultWriter(resultRoot).write(finalResult);
  process.stdout.write(`Actual reconciled model spend: $${actualModelSpendUsd.toFixed(6)}\n`);
  process.stdout.write(`Sandbox usage: ${sandboxCost.sandboxSeconds.toFixed(3)} seconds / $${sandboxCost.sandboxCostUsd.toFixed(6)}\n`);
  process.stdout.write(`Result row written for run ${finalResult.runId}.\n`);
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

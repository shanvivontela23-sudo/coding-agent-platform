import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { CodexHarnessRunner } from "../evals/src/harness/codex.js";
import { E2BSandboxProvider } from "../evals/src/sandbox/e2b-provider.js";
import type { PreparedExecutionSource } from "../apps/worker/src/execution-source.js";
import { inspectPatchSafety } from "../apps/worker/src/patch-safety.js";
import { ProductCodingRunner } from "../apps/worker/src/product-coding-runner.js";
import { verifyExecution } from "../apps/worker/src/verification.js";

const PAID_ACK = "I_UNDERSTAND_PAID_MODEL_AND_E2B_CHARGES";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optional(name: string): string | null {
  const value = process.env[name]?.trim();
  return value || null;
}

async function main(): Promise<void> {
  if (process.env.B2_LIVE_SMOKE !== "1") throw new Error("Set B2_LIVE_SMOKE=1 to opt in to the live B2 smoke.");
  if (process.env.B2_LIVE_PAID_ACK !== PAID_ACK) {
    throw new Error(`Set B2_LIVE_PAID_ACK=${PAID_ACK} to acknowledge paid model and E2B charges.`);
  }

  const archivePath = required("B2_LIVE_SOURCE_ARCHIVE");
  const pinnedCommit = required("B2_LIVE_PINNED_COMMIT");
  if (!/^[0-9a-f]{40}$/.test(pinnedCommit)) throw new Error("B2_LIVE_PINNED_COMMIT must be a lowercase 40-character SHA.");
  const archive = new Uint8Array(await readFile(archivePath));
  const archiveSha256 = createHash("sha256").update(archive).digest("hex");

  const source: PreparedExecutionSource = {
    repository: { pinnedCommit, archiveSha256, archive },
    jobType: optional("B2_LIVE_JOB_TYPE") ?? "bug_fix",
    requirement: required("B2_LIVE_REQUIREMENT"),
    plan: required("B2_LIVE_PLAN"),
    commands: {
      install: optional("B2_LIVE_INSTALL_COMMAND"),
      test: optional("B2_LIVE_TEST_COMMAND"),
      build: optional("B2_LIVE_BUILD_COMMAND"),
    },
    reviewFocus: optional("B2_LIVE_REVIEW_FOCUS") ?? "Review the generated patch and verification evidence.",
  };

  const sandboxProvider = new E2BSandboxProvider({ apiKey: required("E2B_API_KEY") });
  const harness = new CodexHarnessRunner({ version: required("B2_LIVE_CODEX_VERSION") });
  const coder = new ProductCodingRunner({
    sandboxProvider,
    harnessRunner: harness,
    route: {
      gatewayUrl: required("B2_LIVE_GATEWAY_URL"),
      runToken: required("B2_LIVE_RUN_TOKEN"),
      model: required("B2_LIVE_MODEL"),
    },
    readCostUsd: async () => Number(optional("B2_LIVE_COST_USD") ?? "0"),
  });

  const taskId = optional("B2_LIVE_TASK_ID") ?? "b2-live-smoke";
  const coding = await coder.run(taskId, source);
  const safety = inspectPatchSafety(coding.patch, {
    maxFiles: Number(optional("B2_LIVE_MAX_FILES") ?? "50"),
    maxBytes: Number(optional("B2_LIVE_MAX_PATCH_BYTES") ?? String(2 * 1024 * 1024)),
  });
  const verification = await verifyExecution({
    sandboxProvider,
    taskId,
    source,
    patch: coding.patch,
    reproductionCommand: coding.reproductionCommand,
  });

  process.stdout.write(`${JSON.stringify({
    files: safety.files,
    dependencyChanged: safety.dependencyChanged,
    lockfileChanged: safety.lockfileChanged,
    checks: verification.checks.map((check) => ({ name: check.name, status: check.status })),
    reproduced: verification.reproduce.reproduced,
    hasNewFailures: verification.hasNewFailures,
    costUsd: coding.costUsd,
  })}\n`);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "B2 live smoke failed";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});

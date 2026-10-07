import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  FileGatewayStore,
  RunTokenService,
  type GatewayRunRecord,
} from "../gateway/index.js";
import {
  FileHarnessCallStore,
  HarnessSpendReconciler,
  LiteLLMSpendClient,
} from "../gateway/http/index.js";

export type LocalHttpRun = {
  readonly run: GatewayRunRecord;
  readonly token: string;
  readonly gatewayStore: FileGatewayStore;
  readonly callStore: FileHarnessCallStore;
  readonly spendClient: LiteLLMSpendClient;
};

async function createVirtualKey(input: {
  readonly litellmBaseUrl: string;
  readonly adminToken: string;
  readonly runId: string;
  readonly spendCapUsd: number;
  readonly ttlSeconds: number;
}): Promise<string> {
  const response = await fetch(`${input.litellmBaseUrl.replace(/\/$/, "")}/key/generate`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.adminToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      max_budget: input.spendCapUsd,
      duration: `${input.ttlSeconds}s`,
      metadata: { run_id: input.runId },
    }),
  });
  if (!response.ok) throw new Error(`LiteLLM key generation failed with HTTP ${response.status}`);
  const body = await response.json() as { key?: unknown };
  if (typeof body.key !== "string" || !body.key) throw new Error("LiteLLM key generation returned no key");
  return body.key;
}

export async function startLocalHttpRun(input: {
  readonly stateDir: string;
  readonly litellmBaseUrl: string;
  readonly litellmAdminToken: string;
  readonly signingSecret: string;
  readonly allowedModels: readonly string[];
  readonly spendCapUsd: number;
  readonly ttlMs: number;
  readonly runId?: string;
}): Promise<LocalHttpRun> {
  const runId = input.runId ?? `operator-${randomUUID()}`;
  const expiresAtMs = Date.now() + input.ttlMs;
  const upstreamCredential = await createVirtualKey({
    litellmBaseUrl: input.litellmBaseUrl,
    adminToken: input.litellmAdminToken,
    runId,
    spendCapUsd: input.spendCapUsd,
    ttlSeconds: Math.ceil(input.ttlMs / 1000),
  });
  const gatewayStore = new FileGatewayStore({ rootDir: join(input.stateDir, "gateway") });
  const callStore = new FileHarnessCallStore({ rootDir: join(input.stateDir, "http") });
  const spendClient = new LiteLLMSpendClient({ baseUrl: input.litellmBaseUrl, adminToken: input.litellmAdminToken });
  const run: GatewayRunRecord = {
    runId,
    expiresAtMs,
    spendCapUsd: input.spendCapUsd,
    upstreamCredential,
    allowedModels: [...new Set(input.allowedModels)],
    status: "active",
  };
  await gatewayStore.createRun(run);
  const token = new RunTokenService({ secret: input.signingSecret }).issue(runId, expiresAtMs);
  return { run, token, gatewayStore, callStore, spendClient };
}

export async function finishAndReconcileLocalRun(local: LocalHttpRun): Promise<number> {
  const stored = await local.gatewayStore.getRun(local.run.runId);
  if (stored.status === "active") await local.gatewayStore.saveRun({ ...stored, status: "completed" });
  const reconciler = new HarnessSpendReconciler({
    callStore: local.callStore,
    spendSource: local.spendClient,
    timeoutMs: 30_000,
    initialDelayMs: 100,
    maxDelayMs: 2_000,
    costToleranceUsd: 0.000001,
  });
  const result = await reconciler.reconcileRun(local.run);
  return result.totalCostUsd;
}

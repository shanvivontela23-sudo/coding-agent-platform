import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FileHarnessCallStore,
  HarnessSpendReconciler,
  LiteLLMSpendClient,
  type HarnessCallRecord,
  type LiteLLMSpendRecord,
} from "../src/gateway/http/index.js";
import type { GatewayRunRecord } from "../src/gateway/index.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const emptyUsage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
} as const;

function paidCall(
  callId: string,
  overrides: Partial<HarnessCallRecord> = {},
): HarnessCallRecord {
  return {
    runId: "run-1",
    callId,
    method: "POST",
    path: "/v1/responses",
    wireApi: "responses",
    provider: "openai",
    model: "primary-model",
    modelSettings: {},
    paid: true,
    state: "completed",
    usage: { ...emptyUsage, inputTokens: 10, outputTokens: 4 },
    latencyMs: 100,
    litellmCallId: callId,
    listPriceCostUsd: null,
    costPending: true,
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
    ...overrides,
  };
}

function spend(callId: string, costUsd = 0.07): LiteLLMSpendRecord {
  return {
    requestId: `provider-${callId}`,
    litellmCallId: callId,
    spendUsd: costUsd,
    inputTokens: 10,
    outputTokens: 4,
    cachedInputTokens: null,
    cacheWriteInputTokens: null,
    reasoningTokens: null,
  };
}

async function callStore() {
  const root = await mkdtemp(join(tmpdir(), "coding-agent-reconcile-"));
  roots.push(root);
  return new FileHarnessCallStore({ rootDir: root });
}

const run: GatewayRunRecord = {
  runId: "run-1",
  expiresAtMs: 100_000,
  spendCapUsd: 10,
  upstreamCredential: "sk-run-virtual-key",
  allowedModels: ["primary-model"],
  status: "active",
};

describe("LiteLLM spend client", () => {
  it("queries a call by virtual-key hash plus gateway call id without putting the raw key in the URL", async () => {
    const expectedHash = createHash("sha256")
      .update(run.upstreamCredential)
      .digest("hex");
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      expect(url).toContain(`/spend/logs?`);
      expect(url).toContain(`api_key=${expectedHash}`);
      expect(url).toContain("request_id=call-1");
      expect(url).toContain("summarize=false");
      expect(url).not.toContain(run.upstreamCredential);
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        "Bearer admin-secret",
      );
      return new Response(
        JSON.stringify([
          {
            request_id: "provider-call-1",
            litellm_call_id: "call-1",
            spend: 0.07,
            prompt_tokens: 10,
            completion_tokens: 4,
          },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const client = new LiteLLMSpendClient({
      baseUrl: "https://litellm.example.com",
      adminToken: "admin-secret",
      fetch: fetchMock as typeof fetch,
    });

    await expect(client.listCallSpend(run.upstreamCredential, "call-1")).resolves.toEqual([
      spend("call-1"),
    ]);
  });
});

describe("bounded reconciliation", () => {
  it("resolves one pending call inline after delayed LiteLLM persistence", async () => {
    const store = await callStore();
    await store.createCall(paidCall("call-1"));
    const listCallSpend = vi
      .fn<() => Promise<readonly LiteLLMSpendRecord[]>>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([spend("call-1")]);
    let now = 0;
    const delays: number[] = [];
    const reconciler = new HarnessSpendReconciler({
      callStore: store,
      spendSource: {
        listCallSpend: async () => await listCallSpend(),
        listRunSpend: async () => [],
      },
      timeoutMs: 30_000,
      initialDelayMs: 500,
      maxDelayMs: 2_000,
      costToleranceUsd: 0.000001,
      clock: () => now,
      sleep: async (ms) => {
        delays.push(ms);
        now += ms;
      },
    });

    await expect(reconciler.reconcileCall(run, "call-1")).resolves.toMatchObject({
      callId: "call-1",
      costUsd: 0.07,
    });
    expect(delays).toEqual([500, 1_000]);
    expect(await store.getCall("run-1", "call-1")).toMatchObject({
      listPriceCostUsd: 0.07,
      costPending: false,
    });
  });

  it("deduplicates concurrent inline reconciliation for the same pending call", async () => {
    const store = await callStore();
    await store.createCall(paidCall("call-1"));
    let resolveRows!: (rows: readonly LiteLLMSpendRecord[]) => void;
    const rows = new Promise<readonly LiteLLMSpendRecord[]>((resolve) => {
      resolveRows = resolve;
    });
    const listCallSpend = vi.fn(async () => await rows);
    let now = 0;
    const reconciler = new HarnessSpendReconciler({
      callStore: store,
      spendSource: {
        listCallSpend,
        listRunSpend: async () => [],
      },
      timeoutMs: 30_000,
      initialDelayMs: 500,
      maxDelayMs: 2_000,
      costToleranceUsd: 0.000001,
      clock: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });

    const first = reconciler.reconcileCall(run, "call-1");
    const second = reconciler.reconcileCall(run, "call-1");
    await Promise.resolve();
    resolveRows([spend("call-1")]);

    await expect(Promise.all([first, second])).resolves.toEqual([
      { callId: "call-1", costUsd: 0.07 },
      { callId: "call-1", costUsd: 0.07 },
    ]);
    expect(listCallSpend).toHaveBeenCalledTimes(1);
  });

  it("keeps timeout/interrupted lifecycle state while filling authoritative cost", async () => {
    const store = await callStore();
    await store.createCall(
      paidCall("call-1", {
        state: "interrupted",
        usage: emptyUsage,
      }),
    );
    let now = 0;
    const reconciler = new HarnessSpendReconciler({
      callStore: store,
      spendSource: {
        listCallSpend: async () => [spend("call-1")],
        listRunSpend: async () => [],
      },
      timeoutMs: 30_000,
      initialDelayMs: 500,
      maxDelayMs: 2_000,
      costToleranceUsd: 0.000001,
      clock: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });

    await reconciler.reconcileCall(run, "call-1");
    expect(await store.getCall("run-1", "call-1")).toMatchObject({
      state: "interrupted",
      usage: { inputTokens: 10, outputTokens: 4 },
      listPriceCostUsd: 0.07,
      costPending: false,
    });
  });

  it("settles missing spend rows for rate-limited and context-length failures with no usage at zero cost", async () => {
    const store = await callStore();
    await store.createCall(
      paidCall("rate-limited", {
        state: "failed",
        usage: emptyUsage,
        costPending: false,
      }),
    );
    await store.createCall(
      paidCall("context-length", {
        state: "failed",
        usage: emptyUsage,
        costPending: false,
      }),
    );
    let now = 0;
    const reconciler = new HarnessSpendReconciler({
      callStore: store,
      spendSource: {
        listCallSpend: async () => [],
        listRunSpend: async () => [],
      },
      timeoutMs: 500,
      initialDelayMs: 500,
      maxDelayMs: 500,
      costToleranceUsd: 0.000001,
      clock: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });

    await expect(reconciler.reconcileRun(run)).resolves.toEqual({
      totalCostUsd: 0,
      reconciledCallIds: ["context-length", "rate-limited"],
    });
    await expect(store.getCall("run-1", "rate-limited")).resolves.toMatchObject({
      listPriceCostUsd: 0,
      costPending: false,
    });
    await expect(store.getCall("run-1", "context-length")).resolves.toMatchObject({
      listPriceCostUsd: 0,
      costPending: false,
    });
  });

  it("still applies a LiteLLM spend row when one exists for a failed no-usage call", async () => {
    const store = await callStore();
    await store.createCall(
      paidCall("rate-limited", {
        state: "failed",
        usage: emptyUsage,
        costPending: false,
      }),
    );
    await store.createCall(
      paidCall("context-length", {
        state: "failed",
        usage: emptyUsage,
        costPending: false,
      }),
    );
    const rateLimitedSpend: LiteLLMSpendRecord = {
      requestId: "provider-rate-limited",
      litellmCallId: "rate-limited",
      spendUsd: 0.003,
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      cacheWriteInputTokens: null,
      reasoningTokens: null,
    };
    let now = 0;
    const reconciler = new HarnessSpendReconciler({
      callStore: store,
      spendSource: {
        listCallSpend: async () => [],
        listRunSpend: async () => [rateLimitedSpend],
      },
      timeoutMs: 500,
      initialDelayMs: 500,
      maxDelayMs: 500,
      costToleranceUsd: 0.000001,
      clock: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });

    await expect(reconciler.reconcileRun(run)).resolves.toEqual({
      totalCostUsd: 0.003,
      reconciledCallIds: ["context-length", "rate-limited"],
    });
    await expect(store.getCall("run-1", "rate-limited")).resolves.toMatchObject({
      listPriceCostUsd: 0.003,
      costPending: false,
    });
    await expect(store.getCall("run-1", "context-length")).resolves.toMatchObject({
      listPriceCostUsd: 0,
      costPending: false,
    });
  });

  it("fails clearly for duplicate call rows", async () => {
    const store = await callStore();
    await store.createCall(paidCall("call-1"));
    let now = 0;
    const reconciler = new HarnessSpendReconciler({
      callStore: store,
      spendSource: {
        listCallSpend: async () => [spend("call-1"), spend("call-1")],
        listRunSpend: async () => [],
      },
      timeoutMs: 30_000,
      initialDelayMs: 500,
      maxDelayMs: 2_000,
      costToleranceUsd: 0.000001,
      clock: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });

    await expect(reconciler.reconcileCall(run, "call-1")).rejects.toThrow(
      "duplicate LiteLLM spend rows",
    );
  });

  it("waits for all paid rows during final run audit and rejects unexpected rows", async () => {
    const store = await callStore();
    await store.createCall(paidCall("call-1"));
    await store.createCall(paidCall("call-2"));
    let now = 0;
    const snapshots: readonly LiteLLMSpendRecord[][] = [
      [],
      [spend("call-1")],
      [spend("call-1"), spend("call-2")],
    ];
    let index = 0;
    const reconciler = new HarnessSpendReconciler({
      callStore: store,
      spendSource: {
        listCallSpend: async () => [],
        listRunSpend: async () => snapshots[Math.min(index++, snapshots.length - 1)] ?? [],
      },
      timeoutMs: 30_000,
      initialDelayMs: 500,
      maxDelayMs: 2_000,
      costToleranceUsd: 0.000001,
      clock: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });

    await expect(reconciler.reconcileRun(run)).resolves.toMatchObject({
      totalCostUsd: 0.14,
      reconciledCallIds: ["call-1", "call-2"],
    });

    const unexpected = new HarnessSpendReconciler({
      callStore: store,
      spendSource: {
        listCallSpend: async () => [],
        listRunSpend: async () => [spend("call-1"), spend("call-2"), spend("extra")],
      },
      timeoutMs: 30_000,
      initialDelayMs: 500,
      maxDelayMs: 2_000,
      costToleranceUsd: 0.000001,
      clock: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });

    await expect(unexpected.reconcileRun(run)).rejects.toThrow(
      "unexpected LiteLLM spend row",
    );
  });
});

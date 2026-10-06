import type { GatewayRunRecord, ModelUsage } from "../types.js";
import type { HarnessCallRecord, HarnessCallStore } from "./store.js";
import type {
  LiteLLMSpendRecord,
  LiteLLMSpendSource,
} from "./litellm-spend.js";

export type ReconciledCallSpend = {
  readonly callId: string;
  readonly costUsd: number;
};

export type ReconciliationResult = {
  readonly totalCostUsd: number;
  readonly reconciledCallIds: readonly string[];
};

export type HarnessSpendReconcilerOptions = {
  readonly callStore: HarnessCallStore;
  readonly spendSource: LiteLLMSpendSource;
  readonly timeoutMs: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly costToleranceUsd: number;
  readonly clock?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function correlationId(row: LiteLLMSpendRecord): string {
  return row.litellmCallId ?? row.requestId;
}

function withAuthoritativeUsage(
  call: HarnessCallRecord,
  row: LiteLLMSpendRecord,
): ModelUsage {
  const interrupted = call.state === "timeout" || call.state === "interrupted";
  const choose = (current: number, authoritative: number | null): number => {
    if (authoritative === null) return current;
    return interrupted || current === 0 ? authoritative : current;
  };
  return {
    inputTokens: choose(call.usage.inputTokens, row.inputTokens),
    cachedInputTokens: choose(
      call.usage.cachedInputTokens,
      row.cachedInputTokens,
    ),
    cacheWriteInputTokens: choose(
      call.usage.cacheWriteInputTokens,
      row.cacheWriteInputTokens,
    ),
    outputTokens: choose(call.usage.outputTokens, row.outputTokens),
    reasoningTokens: choose(call.usage.reasoningTokens, row.reasoningTokens),
  };
}

function assertTokenMatch(
  call: HarnessCallRecord,
  row: LiteLLMSpendRecord,
): void {
  if (call.state === "timeout" || call.state === "interrupted") return;
  const checks: ReadonlyArray<readonly [string, number, number | null]> = [
    ["input", call.usage.inputTokens, row.inputTokens],
    ["cached-input", call.usage.cachedInputTokens, row.cachedInputTokens],
    [
      "cache-write-input",
      call.usage.cacheWriteInputTokens,
      row.cacheWriteInputTokens,
    ],
    ["output", call.usage.outputTokens, row.outputTokens],
    ["reasoning", call.usage.reasoningTokens, row.reasoningTokens],
  ];
  for (const [name, observed, authoritative] of checks) {
    if (authoritative !== null && observed > 0 && observed !== authoritative) {
      throw new Error(
        `LiteLLM ${name} token mismatch for call ${call.callId}: gateway=${observed} spend=${authoritative}`,
      );
    }
  }
}

export class HarnessSpendReconciler {
  private readonly callStore: HarnessCallStore;
  private readonly spendSource: LiteLLMSpendSource;
  private readonly timeoutMs: number;
  private readonly initialDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly costToleranceUsd: number;
  private readonly clock: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly inFlightCalls = new Map<
    string,
    Promise<ReconciledCallSpend>
  >();

  constructor(options: HarnessSpendReconcilerOptions) {
    if (options.timeoutMs <= 0) throw new Error("reconciliation timeout must be positive");
    if (options.initialDelayMs <= 0) {
      throw new Error("reconciliation initial delay must be positive");
    }
    if (options.maxDelayMs < options.initialDelayMs) {
      throw new Error("reconciliation max delay must be at least the initial delay");
    }
    if (options.costToleranceUsd < 0) {
      throw new Error("cost tolerance must be nonnegative");
    }
    this.callStore = options.callStore;
    this.spendSource = options.spendSource;
    this.timeoutMs = options.timeoutMs;
    this.initialDelayMs = options.initialDelayMs;
    this.maxDelayMs = options.maxDelayMs;
    this.costToleranceUsd = options.costToleranceUsd;
    this.clock = options.clock ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async reconcileCall(
    run: GatewayRunRecord,
    callId: string,
  ): Promise<ReconciledCallSpend> {
    const key = `${run.runId}\u0000${callId}`;
    const existing = this.inFlightCalls.get(key);
    if (existing) return await existing;
    const reconciliation = this.reconcileCallOnce(run, callId);
    this.inFlightCalls.set(key, reconciliation);
    try {
      return await reconciliation;
    } finally {
      if (this.inFlightCalls.get(key) === reconciliation) {
        this.inFlightCalls.delete(key);
      }
    }
  }

  async reconcileRun(run: GatewayRunRecord): Promise<ReconciliationResult> {
    const calls = (await this.callStore.listCalls(run.runId)).filter(
      (call) => call.paid,
    );
    const expected = new Map(calls.map((call) => [call.callId, call]));
    if (expected.size !== calls.length) {
      throw new Error("duplicate paid gateway call id in local call log");
    }
    if (calls.length === 0) {
      return { totalCostUsd: 0, reconciledCallIds: [] };
    }

    const deadline = this.clock() + this.timeoutMs;
    let delay = this.initialDelayMs;
    while (true) {
      await this.sleep(delay);
      const rows = await this.spendSource.listRunSpend(run.upstreamCredential);
      const byId = new Map<string, LiteLLMSpendRecord>();
      for (const row of rows) {
        const id = correlationId(row);
        if (!expected.has(id)) {
          throw new Error(`unexpected LiteLLM spend row for call ${id}`);
        }
        if (byId.has(id)) {
          throw new Error(`duplicate LiteLLM spend rows for call ${id}`);
        }
        byId.set(id, row);
      }

      if (byId.size === expected.size) {
        let totalCostUsd = 0;
        const reconciledCallIds: string[] = [];
        for (const [callId, call] of expected) {
          const row = byId.get(callId);
          if (!row) throw new Error(`missing LiteLLM spend row for call ${callId}`);
          await this.applySpendRow(call, row);
          totalCostUsd += row.spendUsd;
          reconciledCallIds.push(callId);
        }
        reconciledCallIds.sort();
        return { totalCostUsd, reconciledCallIds };
      }

      if (this.clock() >= deadline) {
        const missing = [...expected.keys()].filter((id) => !byId.has(id));
        throw new Error(
          `LiteLLM spend reconciliation timed out; missing calls: ${missing.join(", ")}`,
        );
      }
      delay = Math.min(delay * 2, this.maxDelayMs);
    }
  }

  private async reconcileCallOnce(
    run: GatewayRunRecord,
    callId: string,
  ): Promise<ReconciledCallSpend> {
    const call = await this.callStore.getCall(run.runId, callId);
    if (!call.paid) {
      return { callId, costUsd: 0 };
    }
    if (!call.costPending && call.listPriceCostUsd !== null) {
      return { callId, costUsd: call.listPriceCostUsd };
    }

    const deadline = this.clock() + this.timeoutMs;
    let delay = this.initialDelayMs;
    while (true) {
      await this.sleep(delay);
      const rows = await this.spendSource.listCallSpend(
        run.upstreamCredential,
        callId,
      );
      if (rows.length > 1) {
        throw new Error(`duplicate LiteLLM spend rows for call ${callId}`);
      }
      const row = rows[0];
      if (row) {
        const id = correlationId(row);
        if (id !== callId) {
          throw new Error(
            `unexpected LiteLLM spend row ${id} while reconciling ${callId}`,
          );
        }
        await this.applySpendRow(call, row);
        return { callId, costUsd: row.spendUsd };
      }
      if (this.clock() >= deadline) {
        throw new Error(`LiteLLM spend reconciliation timed out for call ${callId}`);
      }
      delay = Math.min(delay * 2, this.maxDelayMs);
    }
  }

  private async applySpendRow(
    call: HarnessCallRecord,
    row: LiteLLMSpendRecord,
  ): Promise<void> {
    if (
      call.listPriceCostUsd !== null &&
      Math.abs(call.listPriceCostUsd - row.spendUsd) > this.costToleranceUsd
    ) {
      throw new Error(
        `LiteLLM cost mismatch for call ${call.callId}: gateway=${call.listPriceCostUsd} spend=${row.spendUsd}`,
      );
    }
    assertTokenMatch(call, row);
    await this.callStore.saveCall({
      ...call,
      usage: withAuthoritativeUsage(call, row),
      listPriceCostUsd: row.spendUsd,
      costPending: false,
      updatedAtMs: this.clock(),
    });
  }
}

import { runLimits } from "../config/gates.js";
import { ProviderSpendLimitError, RunSpendLimitError } from "./errors.js";
import { hashModelCallRequest } from "./request-hash.js";
import type {
  CostRecord,
  GatewayRunRecord,
  GatewayStore,
  ModelCallRequest,
  ModelGateway,
  ModelGatewayResponse,
  ModelProviderAdapter,
  RunCostSummary,
  StartRunRequest,
  StartRunResponse,
} from "./types.js";
import type { RunTokenService } from "./run-token.js";

export type PersistentModelGatewayOptions = {
  readonly store: GatewayStore;
  readonly adapter: ModelProviderAdapter;
  readonly tokenService: RunTokenService;
  readonly clock?: () => number;
};

const emptySummary: RunCostSummary = {
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  modelCostUsd: 0,
};

function validateCallRequest(request: ModelCallRequest): void {
  if (!request.runId.trim()) throw new Error("runId is required");
  if (!request.idempotencyKey.trim()) throw new Error("idempotencyKey is required");
  if (!request.provider.trim()) throw new Error("provider is required");
  if (!request.model.trim()) throw new Error("model is required");
}

function normalizeAllowedModels(models: readonly string[]): readonly string[] {
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error("allowedModels must contain at least one model");
  }
  const normalized = models.map((model) => model.trim());
  if (normalized.some((model) => !model)) {
    throw new Error("allowedModels may not contain blank model names");
  }
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("allowedModels may not contain duplicates");
  }
  return normalized;
}

function summarize(records: readonly CostRecord[]): RunCostSummary {
  return records.reduce<RunCostSummary>(
    (total, record) => ({
      inputTokens: total.inputTokens + record.inputTokens,
      cachedInputTokens: total.cachedInputTokens + record.cachedInputTokens,
      cacheWriteInputTokens:
        total.cacheWriteInputTokens + record.cacheWriteInputTokens,
      outputTokens: total.outputTokens + record.outputTokens,
      reasoningTokens: total.reasoningTokens + record.reasoningTokens,
      modelCostUsd: total.modelCostUsd + record.listPriceCostUsd,
    }),
    emptySummary,
  );
}

export class PersistentModelGateway implements ModelGateway {
  private readonly store: GatewayStore;
  private readonly adapter: ModelProviderAdapter;
  private readonly tokenService: RunTokenService;
  private readonly clock: () => number;
  private readonly runLocks = new Map<string, Promise<void>>();

  constructor(options: PersistentModelGatewayOptions) {
    this.store = options.store;
    this.adapter = options.adapter;
    this.tokenService = options.tokenService;
    this.clock = options.clock ?? Date.now;
  }

  async startRun(request: StartRunRequest): Promise<StartRunResponse> {
    if (!request.runId.trim()) throw new Error("runId is required");
    if (!Number.isFinite(request.expiresAtMs) || request.expiresAtMs <= this.clock()) {
      throw new Error("run expiry must be in the future");
    }

    const allowedModels = normalizeAllowedModels(request.allowedModels);
    const spendCapUsd = request.spendCapUsd ?? runLimits.spendCapUsd;
    if (!Number.isFinite(spendCapUsd) || spendCapUsd <= 0) {
      throw new Error("run spend cap must be greater than zero");
    }

    const upstream = await this.adapter.startRun({
      runId: request.runId,
      expiresAtMs: request.expiresAtMs,
      spendCapUsd,
    });
    const record: GatewayRunRecord = {
      runId: request.runId,
      expiresAtMs: request.expiresAtMs,
      spendCapUsd,
      upstreamCredential: upstream.credential,
      allowedModels,
      status: "active",
    };
    await this.store.createRun(record);

    return {
      token: this.tokenService.issue(request.runId, request.expiresAtMs),
      expiresAtMs: request.expiresAtMs,
      spendCapUsd,
    };
  }

  async call(
    token: string,
    request: ModelCallRequest,
  ): Promise<ModelGatewayResponse> {
    validateCallRequest(request);
    this.tokenService.verify(token, request.runId);
    const requestHash = hashModelCallRequest(request);

    return await this.withRunLock(request.runId, async () => {
      let run = await this.store.getRun(request.runId);
      const existing = await this.store.getStoredCall(
        request.runId,
        request.idempotencyKey,
      );
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new Error(
            `idempotency key ${request.idempotencyKey} was reused with a different request`,
          );
        }
        return {
          body: existing.response,
          costRecord: existing.costRecord,
          replayed: true,
        };
      }

      if (this.clock() >= run.expiresAtMs) {
        run = { ...run, status: "expired" };
        await this.store.saveRun(run);
      }
      if (run.status !== "active") {
        throw new Error(`run ${request.runId} is not active`);
      }

      const current = await this.getRunCostSummary(request.runId);
      const estimate = await this.adapter.estimateMaxCostUsd(request);
      if (
        estimate !== null &&
        (!Number.isFinite(estimate) || estimate < 0)
      ) {
        throw new Error("provider cost estimate must be a nonnegative number or null");
      }
      if (
        estimate !== null &&
        current.modelCostUsd + estimate > run.spendCapUsd
      ) {
        await this.markLimitHit(run);
        throw new RunSpendLimitError();
      }

      let providerResponse;
      try {
        providerResponse = await this.adapter.call({
          ...request,
          credential: run.upstreamCredential,
        });
      } catch (error) {
        if (error instanceof ProviderSpendLimitError) {
          await this.markLimitHit(run);
          throw new RunSpendLimitError();
        }
        throw error;
      }

      if (
        !Number.isFinite(providerResponse.listPriceCostUsd) ||
        providerResponse.listPriceCostUsd < 0
      ) {
        throw new Error("provider response cost must be a nonnegative number");
      }

      const costRecord: CostRecord = {
        runId: request.runId,
        idempotencyKey: request.idempotencyKey,
        provider: request.provider,
        model: request.model,
        modelSettings: request.modelSettings,
        inputTokens: providerResponse.usage.inputTokens,
        cachedInputTokens: providerResponse.usage.cachedInputTokens,
        cacheWriteInputTokens: providerResponse.usage.cacheWriteInputTokens,
        outputTokens: providerResponse.usage.outputTokens,
        reasoningTokens: providerResponse.usage.reasoningTokens,
        latencyMs: providerResponse.latencyMs,
        listPriceCostUsd: providerResponse.listPriceCostUsd,
        createdAtMs: this.clock(),
      };

      await this.store.saveStoredCall(request.runId, request.idempotencyKey, {
        requestHash,
        response: providerResponse.body,
        costRecord,
      });

      if (current.modelCostUsd + costRecord.listPriceCostUsd > run.spendCapUsd) {
        await this.markLimitHit(run);
        throw new RunSpendLimitError(
          "run spend cap was exceeded by the provider response",
        );
      }

      return {
        body: providerResponse.body,
        costRecord,
        replayed: false,
      };
    });
  }

  async finishRun(runId: string): Promise<void> {
    await this.withRunLock(runId, async () => {
      const run = await this.store.getRun(runId);
      if (run.status === "active") {
        await this.store.saveRun({ ...run, status: "completed" });
      }
    });
  }

  async getRunCostSummary(runId: string): Promise<RunCostSummary> {
    return summarize(await this.store.listCostRecords(runId));
  }

  private async markLimitHit(run: GatewayRunRecord): Promise<void> {
    if (run.status !== "limit-hit") {
      await this.store.saveRun({ ...run, status: "limit-hit" });
    }
  }

  private async withRunLock<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.runLocks.get(runId) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.runLocks.set(runId, tail);

    await previous;
    try {
      return await operation();
    } finally {
      release?.();
      if (this.runLocks.get(runId) === tail) this.runLocks.delete(runId);
    }
  }
}

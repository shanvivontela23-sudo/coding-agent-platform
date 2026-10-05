export type ModelWireApi =
  | "chat-completions"
  | "responses"
  | "anthropic-messages";

export type ModelCallRequest = {
  readonly runId: string;
  readonly idempotencyKey: string;
  readonly provider: string;
  readonly model: string;
  readonly modelSettings: Readonly<Record<string, unknown>>;
  readonly wireApi: ModelWireApi;
  readonly body: Readonly<Record<string, unknown>>;
};

export type ModelUsage = {
  /** Total input tokens consumed, including cache reads/writes where reported. */
  readonly inputTokens: number;
  /** Input tokens served from an existing prompt cache. */
  readonly cachedInputTokens: number;
  /** Input tokens written into a prompt cache for future calls. */
  readonly cacheWriteInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
};

export type CostRecord = ModelUsage & {
  readonly runId: string;
  readonly idempotencyKey: string;
  readonly provider: string;
  readonly model: string;
  readonly modelSettings: Readonly<Record<string, unknown>>;
  readonly latencyMs: number;
  readonly listPriceCostUsd: number;
  readonly createdAtMs: number;
};

export type ModelGatewayResponse = {
  readonly body: Readonly<Record<string, unknown>>;
  readonly costRecord: CostRecord;
  readonly replayed: boolean;
};

export type RunCostSummary = ModelUsage & {
  readonly modelCostUsd: number;
};

export type GatewayRunStatus =
  | "active"
  | "completed"
  | "limit-hit"
  | "expired";

export type GatewayRunRecord = {
  readonly runId: string;
  readonly expiresAtMs: number;
  readonly spendCapUsd: number;
  readonly upstreamCredential: string;
  readonly status: GatewayRunStatus;
};

export type StoredModelCall = {
  readonly requestHash: string;
  readonly response: Readonly<Record<string, unknown>>;
  readonly costRecord: CostRecord;
};

export type StartRunRequest = {
  readonly runId: string;
  readonly expiresAtMs: number;
  readonly spendCapUsd?: number;
};

export type StartRunResponse = {
  readonly token: string;
  readonly expiresAtMs: number;
  readonly spendCapUsd: number;
};

export interface ModelGateway {
  startRun(request: StartRunRequest): Promise<StartRunResponse>;
  call(token: string, request: ModelCallRequest): Promise<ModelGatewayResponse>;
  finishRun(runId: string): Promise<void>;
  getRunCostSummary(runId: string): Promise<RunCostSummary>;
}

export type ProviderRunStartRequest = {
  readonly runId: string;
  readonly expiresAtMs: number;
  readonly spendCapUsd: number;
};

export type ProviderRunCredential = {
  readonly credential: string;
};

export type ProviderCallRequest = ModelCallRequest & {
  readonly credential: string;
};

export type ProviderCallResponse = {
  readonly body: Readonly<Record<string, unknown>>;
  readonly usage: ModelUsage;
  readonly latencyMs: number;
  readonly listPriceCostUsd: number;
};

export interface ModelProviderAdapter {
  startRun(request: ProviderRunStartRequest): Promise<ProviderRunCredential>;
  estimateMaxCostUsd(request: ModelCallRequest): Promise<number | null>;
  call(request: ProviderCallRequest): Promise<ProviderCallResponse>;
}

export interface GatewayStore {
  createRun(record: GatewayRunRecord): Promise<void>;
  getRun(runId: string): Promise<GatewayRunRecord>;
  saveRun(record: GatewayRunRecord): Promise<void>;
  getStoredCall(
    runId: string,
    idempotencyKey: string,
  ): Promise<StoredModelCall | null>;
  saveStoredCall(
    runId: string,
    idempotencyKey: string,
    call: StoredModelCall,
  ): Promise<void>;
  listCostRecords(runId: string): Promise<readonly CostRecord[]>;
}

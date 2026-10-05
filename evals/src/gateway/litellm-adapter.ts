import { ProviderSpendLimitError } from "./errors.js";
import type {
  ModelProviderAdapter,
  ProviderCallRequest,
  ProviderCallResponse,
  ProviderRunCredential,
  ProviderRunStartRequest,
} from "./types.js";
import { normalizeModelUsage } from "./usage.js";

export type GatewayFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export type LiteLLMAdapterOptions = {
  readonly baseUrl: string;
  readonly adminToken: string;
  readonly fetch?: GatewayFetch;
  readonly clock?: () => number;
};

const endpointByWireApi = {
  "chat-completions": "/v1/chat/completions",
  responses: "/v1/responses",
  "anthropic-messages": "/v1/messages",
} as const;

const forbiddenSettingName = /(api[-_]?key|token|secret|password|authorization)/i;

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function assertSafeModelSettings(settings: Readonly<Record<string, unknown>>): void {
  for (const key of Object.keys(settings)) {
    if (forbiddenSettingName.test(key)) {
      throw new Error(`model setting ${key} may not contain credentials`);
    }
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost") {
    throw new Error("LiteLLM baseUrl must use https outside localhost");
  }
  return parsed.toString().replace(/\/$/, "");
}

export class LiteLLMAdapter implements ModelProviderAdapter {
  private readonly baseUrl: string;
  private readonly adminToken: string;
  private readonly fetchImpl: GatewayFetch;
  private readonly clock: () => number;

  constructor(options: LiteLLMAdapterOptions) {
    if (!options.adminToken.trim()) {
      throw new Error("LiteLLM admin token is required");
    }
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.adminToken = options.adminToken;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.clock = options.clock ?? Date.now;
  }

  async startRun(
    request: ProviderRunStartRequest,
  ): Promise<ProviderRunCredential> {
    const ttlMs = request.expiresAtMs - this.clock();
    if (ttlMs <= 0) throw new Error("run expiry must be in the future");
    const durationSeconds = Math.max(1, Math.ceil(ttlMs / 1_000));

    const response = await this.fetchImpl(`${this.baseUrl}/key/generate`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        max_budget: request.spendCapUsd,
        duration: `${durationSeconds}s`,
        metadata: { run_id: request.runId },
      }),
    });

    if (!response.ok) {
      throw new Error(`LiteLLM run key creation failed with status ${response.status}`);
    }
    const body = asObject(await response.json());
    if (typeof body.key !== "string" || !body.key) {
      throw new Error("LiteLLM run key response did not include a key");
    }
    return { credential: body.key };
  }

  async estimateMaxCostUsd(): Promise<number | null> {
    // LiteLLM's per-run virtual key is the authoritative reservation boundary.
    // With a database-backed gateway, LiteLLM reserves estimated request cost
    // against max_budget before contacting the provider.
    return null;
  }

  async call(request: ProviderCallRequest): Promise<ProviderCallResponse> {
    assertSafeModelSettings(request.modelSettings);
    const startedAt = this.clock();
    const endpoint = endpointByWireApi[request.wireApi];
    const response = await this.fetchImpl(`${this.baseUrl}${endpoint}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${request.credential}`,
        "Content-Type": "application/json",
        "Idempotency-Key": request.idempotencyKey,
        "x-litellm-spend-logs-metadata": JSON.stringify({
          run_id: request.runId,
          idempotency_key: request.idempotencyKey,
          provider: request.provider,
          model: request.model,
        }),
      },
      body: JSON.stringify({
        ...request.body,
        ...request.modelSettings,
        model: request.model,
      }),
    });
    const latencyMs = Math.max(0, this.clock() - startedAt);

    if (!response.ok) {
      const responseText = await response.text();
      if (
        response.status === 429 &&
        /(budget|spend|limit)/i.test(responseText)
      ) {
        throw new ProviderSpendLimitError();
      }
      throw new Error(`LiteLLM inference failed with status ${response.status}`);
    }

    const body = asObject(await response.json());
    const costHeader = response.headers.get("x-litellm-response-cost");
    const listPriceCostUsd = costHeader === null ? Number.NaN : Number(costHeader);
    if (!Number.isFinite(listPriceCostUsd) || listPriceCostUsd < 0) {
      throw new Error("LiteLLM response did not include a valid response cost");
    }

    return {
      body,
      usage: normalizeModelUsage(request.wireApi, body),
      latencyMs,
      listPriceCostUsd,
    };
  }
}

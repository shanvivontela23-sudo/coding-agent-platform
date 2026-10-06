import { createHash } from "node:crypto";

export type LiteLLMSpendRecord = {
  readonly requestId: string;
  readonly litellmCallId: string | null;
  readonly spendUsd: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly cacheWriteInputTokens: number | null;
  readonly reasoningTokens: number | null;
};

export interface LiteLLMSpendSource {
  listCallSpend(
    upstreamCredential: string,
    callId: string,
  ): Promise<readonly LiteLLMSpendRecord[]>;
  listRunSpend(
    upstreamCredential: string,
  ): Promise<readonly LiteLLMSpendRecord[]>;
}

export type LiteLLMSpendClientOptions = {
  readonly baseUrl: string;
  readonly adminToken: string;
  readonly fetch?: typeof fetch;
};

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function nullableToken(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function requiredCost(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error("LiteLLM spend row has invalid spend");
  }
  return value;
}

function normalizeBaseUrl(baseUrl: string): string {
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost") {
    throw new Error("LiteLLM baseUrl must use https outside localhost");
  }
  return parsed.toString().replace(/\/$/, "");
}

function usageField(
  row: Record<string, unknown>,
  metadata: Record<string, unknown>,
  names: readonly string[],
): number | null {
  const usage = asObject(metadata.usage_object);
  for (const name of names) {
    const fromUsage = nullableToken(usage[name]);
    if (fromUsage !== null) return fromUsage;
    const fromRow = nullableToken(row[name]);
    if (fromRow !== null) return fromRow;
  }
  return null;
}

function parseSpendRow(value: unknown): LiteLLMSpendRecord {
  const row = asObject(value);
  const requestId = row.request_id;
  if (typeof requestId !== "string" || requestId.length === 0) {
    throw new Error("LiteLLM spend row is missing request_id");
  }
  const litellmCallId =
    typeof row.litellm_call_id === "string" && row.litellm_call_id.length > 0
      ? row.litellm_call_id
      : null;
  const metadata = asObject(row.metadata);
  const cached = usageField(row, metadata, [
    "cached_input_tokens",
    "cache_read_input_tokens",
  ]);
  const cacheWrite = usageField(row, metadata, [
    "cache_write_input_tokens",
    "cache_creation_input_tokens",
  ]);
  const reasoning = usageField(row, metadata, ["reasoning_tokens"]);

  return {
    requestId,
    litellmCallId,
    spendUsd: requiredCost(row.spend),
    inputTokens: usageField(row, metadata, [
      "input_tokens",
      "prompt_tokens",
    ]),
    outputTokens: usageField(row, metadata, [
      "output_tokens",
      "completion_tokens",
    ]),
    cachedInputTokens: cached,
    cacheWriteInputTokens: cacheWrite,
    reasoningTokens: reasoning,
  };
}

function virtualKeyHash(upstreamCredential: string): string {
  return createHash("sha256").update(upstreamCredential).digest("hex");
}

export class LiteLLMSpendClient implements LiteLLMSpendSource {
  private readonly baseUrl: string;
  private readonly adminToken: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: LiteLLMSpendClientOptions) {
    if (!options.adminToken.trim()) throw new Error("LiteLLM admin token is required");
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.adminToken = options.adminToken;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async listCallSpend(
    upstreamCredential: string,
    callId: string,
  ): Promise<readonly LiteLLMSpendRecord[]> {
    if (!callId.trim()) throw new Error("callId is required");
    return await this.fetchSpend(upstreamCredential, callId);
  }

  async listRunSpend(
    upstreamCredential: string,
  ): Promise<readonly LiteLLMSpendRecord[]> {
    return await this.fetchSpend(upstreamCredential);
  }

  private async fetchSpend(
    upstreamCredential: string,
    callId?: string,
  ): Promise<readonly LiteLLMSpendRecord[]> {
    if (!upstreamCredential.trim()) {
      throw new Error("run-scoped LiteLLM credential is required");
    }
    const params = new URLSearchParams({
      api_key: virtualKeyHash(upstreamCredential),
      summarize: "false",
    });
    if (callId) params.set("request_id", callId);

    const response = await this.fetchImpl(
      `${this.baseUrl}/spend/logs?${params.toString()}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${this.adminToken}` },
      },
    );
    if (!response.ok) {
      throw new Error(`LiteLLM spend lookup failed with status ${response.status}`);
    }
    if (response.headers.get("x-litellm-spend-logs-truncated") === "true") {
      throw new Error("LiteLLM spend lookup was truncated");
    }
    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) {
      throw new Error("LiteLLM spend lookup returned an unexpected payload");
    }
    return payload.map(parseSpendRow);
  }
}

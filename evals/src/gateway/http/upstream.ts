import type { GatewayStore, ModelUsage } from "../types.js";
import { normalizeModelUsage, normalizeTokenCountUsage } from "../usage.js";
import type {
  HarnessDispatchRequest,
  HarnessOutboundResponse,
} from "./handler.js";
import type { HarnessCallRecord, HarnessCallStore } from "./store.js";

export type LiteLLMHarnessTransportOptions = {
  readonly baseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly gatewayStore: GatewayStore;
  readonly callStore: HarnessCallStore;
  readonly nonStreamingTimeoutMs: number;
  readonly clock?: () => number;
};

function normalizeBaseUrl(baseUrl: string): string {
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost") {
    throw new Error("LiteLLM baseUrl must use https outside localhost");
  }
  return parsed.toString().replace(/\/$/, "");
}

function findHeader(
  headers: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}

function selectRequestHeaders(request: HarnessDispatchRequest): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const allowed of request.route.forwardRequestHeaders) {
    const value = findHeader(request.requestHeaders, allowed);
    if (value !== undefined) selected[allowed] = value;
  }
  selected.Authorization = `Bearer ${request.run.upstreamCredential}`;
  selected["Content-Type"] = "application/json";
  selected["x-litellm-call-id"] = request.callId;
  selected["x-litellm-spend-logs-metadata"] = JSON.stringify({
    run_id: request.run.runId,
    gateway_call_id: request.callId,
  });
  return selected;
}

function selectResponseHeaders(
  response: Response,
  allowed: readonly string[],
): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const name of allowed) {
    const value = response.headers.get(name);
    if (value !== null) selected[name] = value;
  }
  if (!("content-type" in selected)) selected["content-type"] = "application/json";
  return selected;
}

function emptyUsage(): ModelUsage {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  };
}

function safeError(status: number, code: string, message: string): HarnessOutboundResponse {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify({ error: { code, message } })),
  };
}

function parseJsonObject(bytes: Uint8Array): Readonly<Record<string, unknown>> | null {
  try {
    const parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Readonly<Record<string, unknown>>)
      : null;
  } catch {
    return null;
  }
}

function isBudgetRejection(status: number, bytes: Uint8Array): boolean {
  return status === 429 && /(budget|spend|limit)/i.test(Buffer.from(bytes).toString("utf8"));
}

export class LiteLLMHarnessTransport {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly gatewayStore: GatewayStore;
  private readonly callStore: HarnessCallStore;
  private readonly timeoutMs: number;
  private readonly clock: () => number;

  constructor(options: LiteLLMHarnessTransportOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.gatewayStore = options.gatewayStore;
    this.callStore = options.callStore;
    if (!Number.isInteger(options.nonStreamingTimeoutMs) || options.nonStreamingTimeoutMs <= 0) {
      throw new Error("nonStreamingTimeoutMs must be a positive integer");
    }
    this.timeoutMs = options.nonStreamingTimeoutMs;
    this.clock = options.clock ?? Date.now;
  }

  async forward(
    request: HarnessDispatchRequest,
    externalSignal?: AbortSignal,
  ): Promise<HarnessOutboundResponse> {
    const startedAt = this.clock();
    let record: HarnessCallRecord = {
      runId: request.run.runId,
      callId: request.callId,
      method: request.route.method,
      path: request.route.path,
      wireApi: request.route.wireApi,
      provider: request.provider,
      model: request.model,
      modelSettings: request.modelSettings,
      paid: request.route.paid,
      state: "accepted",
      usage: emptyUsage(),
      latencyMs: null,
      litellmCallId: request.callId,
      listPriceCostUsd: null,
      createdAtMs: startedAt,
      updatedAtMs: startedAt,
    };
    await this.callStore.createCall(record);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const signal = externalSignal
      ? AbortSignal.any([controller.signal, externalSignal])
      : controller.signal;

    try {
      const response = await this.fetchImpl(`${this.baseUrl}${request.route.path}`, {
        method: "POST",
        headers: selectRequestHeaders(request),
        body: JSON.stringify(request.body),
        signal,
      });
      const bytes = new Uint8Array(await response.arrayBuffer());
      const latencyMs = Math.max(0, this.clock() - startedAt);

      if (!response.ok) {
        if (isBudgetRejection(response.status, bytes)) {
          await this.gatewayStore.saveRun({ ...request.run, status: "limit-hit" });
          record = {
            ...record,
            state: "failed",
            latencyMs,
            listPriceCostUsd: 0,
            updatedAtMs: this.clock(),
          };
          await this.callStore.saveCall(record);
          return safeError(429, "spend_limit", "run spend limit has been reached");
        }
        record = {
          ...record,
          state: "failed",
          latencyMs,
          updatedAtMs: this.clock(),
        };
        await this.callStore.saveCall(record);
        return safeError(502, "upstream_error", "upstream model gateway request failed");
      }

      const body = parseJsonObject(bytes);
      if (!body) {
        record = {
          ...record,
          state: "failed",
          latencyMs,
          updatedAtMs: this.clock(),
        };
        await this.callStore.saveCall(record);
        return safeError(502, "upstream_error", "upstream response was not valid JSON");
      }

      const usage = request.route.paid
        ? normalizeModelUsage(request.route.wireApi, body)
        : normalizeTokenCountUsage(body);
      let listPriceCostUsd = 0;
      if (request.route.paid) {
        const rawCost = response.headers.get("x-litellm-response-cost");
        listPriceCostUsd = rawCost === null ? Number.NaN : Number(rawCost);
        if (!Number.isFinite(listPriceCostUsd) || listPriceCostUsd < 0) {
          record = {
            ...record,
            state: "failed",
            usage,
            latencyMs,
            updatedAtMs: this.clock(),
          };
          await this.callStore.saveCall(record);
          return safeError(502, "metering_error", "upstream cost metadata is missing");
        }
      }

      record = {
        ...record,
        state: "completed",
        usage,
        latencyMs,
        listPriceCostUsd,
        updatedAtMs: this.clock(),
      };
      await this.callStore.saveCall(record);
      return {
        status: response.status,
        headers: selectResponseHeaders(response, request.route.safeResponseHeaders),
        body: bytes,
      };
    } catch (error) {
      void error;
      const interrupted = externalSignal?.aborted === true;
      const timedOut = controller.signal.aborted && !interrupted;
      record = {
        ...record,
        state: timedOut ? "timeout" : interrupted ? "interrupted" : "failed",
        latencyMs: Math.max(0, this.clock() - startedAt),
        updatedAtMs: this.clock(),
      };
      await this.callStore.saveCall(record);
      if (timedOut) return safeError(504, "upstream_timeout", "upstream request timed out");
      if (interrupted) return safeError(499, "client_closed", "client disconnected");
      return safeError(502, "upstream_error", "upstream model gateway request failed");
    } finally {
      clearTimeout(timer);
    }
  }
}

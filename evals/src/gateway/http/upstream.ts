import { randomUUID } from "node:crypto";
import type { GatewayStore, ModelUsage } from "../types.js";
import { emptyModelUsage, normalizeModelUsage } from "../usage.js";
import type {
  HarnessDispatchRequest,
  HarnessHttpDispatcher,
} from "./handler.js";
import type {
  HarnessCallRecord,
  HarnessCallStore,
} from "./store.js";
import type { HarnessHttpConfig, HarnessRouteSpec } from "./types.js";

export type HarnessFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export type LiteLLMHarnessTransportOptions = {
  readonly baseUrl: string;
  readonly fetch?: HarnessFetch;
};

export type HarnessUpstreamRequest = {
  readonly route: HarnessRouteSpec;
  readonly body: Readonly<Record<string, unknown>>;
  readonly clientHeaders: Headers;
  readonly credential: string;
  readonly callId: string;
  readonly signal: AbortSignal;
};

export type NonStreamingHarnessDispatcherOptions = {
  readonly transport: LiteLLMHarnessTransport;
  readonly gatewayStore: GatewayStore;
  readonly callStore: HarnessCallStore;
  readonly config: HarnessHttpConfig;
  readonly clock?: () => number;
  readonly createCallId?: () => string;
};

function normalizeBaseUrl(baseUrl: string): string {
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost") {
    throw new Error("LiteLLM baseUrl must use https outside localhost");
  }
  return parsed.toString().replace(/\/$/, "");
}

function providerForRoute(route: HarnessRouteSpec): string {
  return route.wireApi === "anthropic-messages" ? "anthropic" : "openai";
}

function safeModelSettings(
  route: HarnessRouteSpec,
  body: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const settings: Record<string, unknown> = {};
  for (const field of route.modelSettingFields) {
    if (field in body) settings[field] = body[field];
  }
  return settings;
}

function safeResponseHeaders(
  route: HarnessRouteSpec,
  source: Headers,
): Headers {
  const headers = new Headers();
  for (const name of route.forwardedResponseHeaders) {
    const value = source.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}

function sanitizedError(
  status: number,
  code: string,
  message: string,
): Response {
  return Response.json(
    { error: { message, type: "api_error", code } },
    { status },
  );
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function provisionalCost(response: Response): number | null {
  const value = response.headers.get("x-litellm-response-cost");
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function isLiteLLMBudgetRejection(status: number, body: string): boolean {
  return status === 429 && /(budget|spend|limit)/i.test(body);
}

function recordWith(
  record: HarnessCallRecord,
  updates: Partial<
    Pick<
      HarnessCallRecord,
      "state" | "usage" | "latencyMs" | "listPriceCostUsd" | "updatedAtMs"
    >
  >,
): HarnessCallRecord {
  return { ...record, ...updates };
}

export class LiteLLMHarnessTransport {
  private readonly baseUrl: string;
  private readonly fetchImpl: HarnessFetch;

  constructor(options: LiteLLMHarnessTransportOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async forward(request: HarnessUpstreamRequest): Promise<Response> {
    const headers = new Headers();
    for (const name of request.route.forwardedRequestHeaders) {
      const value = request.clientHeaders.get(name);
      if (value !== null) headers.set(name, value);
    }
    headers.set("authorization", `Bearer ${request.credential}`);
    headers.set("content-type", "application/json");
    headers.set("x-litellm-call-id", request.callId);

    return await this.fetchImpl(`${this.baseUrl}${request.route.path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(request.body),
      signal: request.signal,
    });
  }
}

export function createNonStreamingHarnessDispatcher(
  options: NonStreamingHarnessDispatcherOptions,
): HarnessHttpDispatcher {
  const clock = options.clock ?? Date.now;
  const createCallId = options.createCallId ?? randomUUID;

  return async (input: HarnessDispatchRequest): Promise<Response> => {
    const callId = createCallId();
    const model = String(input.body.model);
    const createdAtMs = clock();
    const initial: HarnessCallRecord = {
      runId: input.claims.runId,
      callId,
      route: input.route.path,
      wireApi: input.route.wireApi,
      provider: providerForRoute(input.route),
      model,
      modelSettings: safeModelSettings(input.route, input.body),
      paid: input.route.paid,
      state: "accepted",
      usage: { ...emptyModelUsage },
      latencyMs: null,
      litellmCallId: callId,
      listPriceCostUsd: input.route.paid ? null : 0,
      createdAtMs,
      updatedAtMs: createdAtMs,
    };
    await options.callStore.createCall(initial);

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort("non-streaming upstream timeout"),
      options.config.nonStreamingTimeoutMs,
    );

    let upstream: Response;
    try {
      upstream = await options.transport.forward({
        route: input.route,
        body: input.body,
        clientHeaders: input.request.headers,
        credential: input.run.upstreamCredential,
        callId,
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timeout);
      const state = controller.signal.aborted ? "timeout" : "interrupted";
      await options.callStore.saveCall(
        recordWith(initial, {
          state,
          latencyMs: Math.max(0, clock() - createdAtMs),
          updatedAtMs: clock(),
        }),
      );
      return sanitizedError(
        state === "timeout" ? 504 : 502,
        state === "timeout" ? "upstream_timeout" : "upstream_failure",
        state === "timeout" ? "upstream request timed out" : "upstream request failed",
      );
    } finally {
      clearTimeout(timeout);
    }

    const responseText = await upstream.text();
    const latencyMs = Math.max(0, clock() - createdAtMs);

    if (isLiteLLMBudgetRejection(upstream.status, responseText)) {
      await options.callStore.saveCall(
        recordWith(initial, {
          state: "rejected",
          latencyMs,
          updatedAtMs: clock(),
        }),
      );
      await options.gatewayStore.saveRun({ ...input.run, status: "limit-hit" });
      return sanitizedError(429, "run_spend_limit", "run spend limit reached");
    }

    if (!upstream.ok) {
      await options.callStore.saveCall(
        recordWith(initial, {
          state: "rejected",
          latencyMs,
          updatedAtMs: clock(),
        }),
      );
      return sanitizedError(
        upstream.status >= 500 ? 502 : upstream.status,
        "upstream_rejected",
        "upstream request was rejected",
      );
    }

    let usage: ModelUsage = { ...emptyModelUsage };
    if (input.route.paid) {
      try {
        usage = normalizeModelUsage(
          input.route.wireApi,
          asObject(JSON.parse(responseText) as unknown),
        );
      } catch {
        await options.callStore.saveCall(
          recordWith(initial, {
            state: "interrupted",
            latencyMs,
            updatedAtMs: clock(),
          }),
        );
        return sanitizedError(502, "invalid_upstream_response", "upstream returned an invalid response");
      }
    }

    await options.callStore.saveCall(
      recordWith(initial, {
        state: "completed",
        usage,
        latencyMs,
        listPriceCostUsd: input.route.paid ? provisionalCost(upstream) : 0,
        updatedAtMs: clock(),
      }),
    );

    return new Response(responseText, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: safeResponseHeaders(input.route, upstream.headers),
    });
  };
}

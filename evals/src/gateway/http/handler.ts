import { randomUUID } from "node:crypto";
import type { GatewayRunRecord, GatewayStore } from "../types.js";
import type { RunTokenService } from "../run-token.js";
import { authenticateHarnessRequest, type HarnessHeaders } from "./auth.js";
import { getHarnessRoute } from "./route-registry.js";
import { RequestBodyTooLargeError, readJsonBodyWithinLimit } from "./request-body.js";
import type { HarnessCallStore } from "./store.js";
import type { HarnessHttpConfig, HarnessRouteSpec } from "./types.js";
import type { RunTokenBucket } from "./rate-limiter.js";

export type HarnessInboundRequest = {
  readonly method: string;
  readonly path: string;
  readonly headers: HarnessHeaders;
  readonly body: AsyncIterable<Uint8Array>;
};

export type HarnessOutboundResponse = {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
};

export type HarnessDispatchRequest = {
  readonly run: GatewayRunRecord;
  readonly route: HarnessRouteSpec;
  readonly requestHeaders: HarnessHeaders;
  readonly body: Readonly<Record<string, unknown>>;
  readonly callId: string;
  readonly provider: "openai" | "anthropic";
  readonly model: string;
  readonly modelSettings: Readonly<Record<string, unknown>>;
};

export type HarnessDispatch = (
  request: HarnessDispatchRequest,
) => Promise<HarnessOutboundResponse>;

export type HarnessHttpHandlerOptions = {
  readonly config: HarnessHttpConfig;
  readonly tokenService: RunTokenService;
  readonly gatewayStore: GatewayStore;
  readonly callStore: HarnessCallStore;
  readonly rateLimiter: RunTokenBucket;
  readonly dispatch: HarnessDispatch;
  readonly clock?: () => number;
};

function jsonError(status: number, code: string, message: string): HarnessOutboundResponse {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify({ error: { code, message } })),
  };
}

function normalizePath(path: string): string {
  try {
    return new URL(path, "https://gateway.invalid").pathname;
  } catch {
    return path.split("?", 1)[0] ?? path;
  }
}

function providerFor(route: HarnessRouteSpec): "openai" | "anthropic" {
  return route.wireApi === "anthropic-messages" ? "anthropic" : "openai";
}

function getModel(
  body: Readonly<Record<string, unknown>>,
  route: HarnessRouteSpec,
): string | null {
  const value = body[route.modelField];
  return typeof value === "string" && value.length > 0 ? value : null;
}

const reasoningEfforts = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);
const reasoningSummaries = new Set(["auto", "concise", "detailed"]);
const numericSettings = new Set(["temperature", "top_p"]);
const integerSettings = new Set(["top_k", "max_tokens", "max_output_tokens"]);

function safeReasoning(value: unknown): Readonly<Record<string, string>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  const result: Record<string, string> = {};
  if (typeof object.effort === "string" && reasoningEfforts.has(object.effort)) {
    result.effort = object.effort;
  }
  if (typeof object.summary === "string" && reasoningSummaries.has(object.summary)) {
    result.summary = object.summary;
  }
  return Object.keys(result).length > 0 ? result : null;
}

function safeModelSettings(
  body: Readonly<Record<string, unknown>>,
  route: HarnessRouteSpec,
): Readonly<Record<string, unknown>> {
  const settings: Record<string, unknown> = {};
  for (const field of route.modelSettingFields) {
    const value = body[field];
    if (numericSettings.has(field)) {
      if (typeof value === "number" && Number.isFinite(value)) settings[field] = value;
      continue;
    }
    if (integerSettings.has(field)) {
      if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
        settings[field] = value;
      }
      continue;
    }
    if (field === "reasoning_effort") {
      if (typeof value === "string" && reasoningEfforts.has(value)) {
        settings[field] = value;
      }
      continue;
    }
    if (field === "reasoning") {
      const reasoning = safeReasoning(value);
      if (reasoning) settings[field] = reasoning;
    }
  }
  return settings;
}

export function createHarnessHttpHandler(options: HarnessHttpHandlerOptions) {
  const clock = options.clock ?? Date.now;

  return async function handle(
    request: HarnessInboundRequest,
  ): Promise<HarnessOutboundResponse> {
    let authentication;
    try {
      authentication = authenticateHarnessRequest(request.headers, options.tokenService);
    } catch {
      return jsonError(401, "unauthorized", "invalid or missing run credential");
    }

    const { claims, token } = authentication;
    let run: GatewayRunRecord;
    try {
      run = await options.gatewayStore.getRun(claims.runId);
    } catch {
      return jsonError(401, "unauthorized", "run is not available");
    }

    if (run.status === "limit-hit") {
      return jsonError(429, "spend_limit", "run spend limit has been reached");
    }
    if (run.status !== "active" || clock() >= run.expiresAtMs) {
      return jsonError(401, "inactive_run", "run is not active");
    }

    if (!options.rateLimiter.consume(token)) {
      return jsonError(429, "rate_limit", "run request rate limit exceeded");
    }

    const path = normalizePath(request.path);
    const route = getHarnessRoute(request.method, path, options.config);
    if (!route || !route.enabled) {
      await options.callStore.appendRefusal({
        runId: run.runId,
        refusalId: randomUUID(),
        timestampMs: clock(),
        method: request.method.toUpperCase(),
        path,
        reason: route ? "disabled-route" : "unknown-route",
      });
      return jsonError(404, "not_found", "route is not available");
    }

    let body: Readonly<Record<string, unknown>>;
    try {
      body = await readJsonBodyWithinLimit(
        request.body,
        options.config.limits.maxBodyBytes,
      );
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        return jsonError(413, "request_too_large", "request body is too large");
      }
      return jsonError(400, "invalid_request", "request body is invalid");
    }

    if (body.stream !== undefined && body.stream !== false && !route.streamingAllowed) {
      await options.callStore.appendRefusal({
        runId: run.runId,
        refusalId: randomUUID(),
        timestampMs: clock(),
        method: request.method.toUpperCase(),
        path,
        reason: "streaming-not-available",
      });
      return jsonError(
        400,
        "streaming_not_available",
        "streaming is not enabled for this route",
      );
    }

    const model = getModel(body, route);
    if (!model || !run.allowedModels.includes(model)) {
      await options.callStore.appendRefusal({
        runId: run.runId,
        refusalId: randomUUID(),
        timestampMs: clock(),
        method: request.method.toUpperCase(),
        path,
        reason: "model-not-allowed",
      });
      return jsonError(400, "model_not_allowed", "requested model is not allowed");
    }

    return await options.dispatch({
      run,
      route,
      requestHeaders: request.headers,
      body,
      callId: randomUUID(),
      provider: providerFor(route),
      model,
      modelSettings: safeModelSettings(body, route),
    });
  };
}

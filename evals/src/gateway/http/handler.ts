import type { GatewayRunRecord, GatewayStore } from "../types.js";
import type { RunTokenClaims, RunTokenService } from "../run-token.js";
import { authenticateHarnessRequest } from "./auth.js";
import { getHarnessRoute } from "./route-registry.js";
import { RunTokenBucket } from "./rate-limiter.js";
import {
  readJsonBodyWithinLimit,
  RequestBodyTooLargeError,
} from "./request-body.js";
import type { HarnessCallStore } from "./store.js";
import type { HarnessHttpConfig, HarnessRouteSpec } from "./types.js";

export type HarnessDispatchRequest = {
  readonly request: Request;
  readonly token: string;
  readonly claims: RunTokenClaims;
  readonly run: GatewayRunRecord;
  readonly route: HarnessRouteSpec;
  readonly body: Readonly<Record<string, unknown>>;
};

export type HarnessHttpDispatcher = (
  request: HarnessDispatchRequest,
) => Promise<Response>;

export type HarnessHttpHandlerOptions = {
  readonly tokenService: RunTokenService;
  readonly gatewayStore: GatewayStore;
  readonly callStore: HarnessCallStore;
  readonly config: HarnessHttpConfig;
  readonly dispatch: HarnessHttpDispatcher;
  readonly clock?: () => number;
  readonly rateLimiter?: RunTokenBucket;
};

function errorResponse(status: number, code: string, message: string): Response {
  return Response.json(
    { error: { message, type: "invalid_request_error", code } },
    { status },
  );
}

async function safeRefusal(
  store: HarnessCallStore,
  runId: string,
  request: Request,
  reason: string,
  clock: () => number,
): Promise<void> {
  await store.appendRefusal({
    runId,
    timestampMs: clock(),
    method: request.method.toUpperCase(),
    path: new URL(request.url).pathname,
    reason,
  });
}

function requestsStreaming(
  request: Request,
  body: Readonly<Record<string, unknown>>,
): boolean {
  return (
    body.stream === true ||
    request.headers
      .get("accept")
      ?.toLowerCase()
      .split(",")
      .some((value) => value.trim().startsWith("text/event-stream")) === true
  );
}

export function createHarnessHttpHandler(
  options: HarnessHttpHandlerOptions,
): (request: Request) => Promise<Response> {
  const clock = options.clock ?? Date.now;
  const rateLimiter =
    options.rateLimiter ??
    new RunTokenBucket({
      ratePerMinute: options.config.ratePerMinute,
      burst: options.config.rateBurst,
      clock,
    });

  return async (request: Request): Promise<Response> => {
    let authentication;
    try {
      authentication = authenticateHarnessRequest(
        request.headers,
        options.tokenService,
      );
    } catch {
      return errorResponse(401, "invalid_run_token", "invalid run credential");
    }

    const { token, claims } = authentication;
    let run: GatewayRunRecord;
    try {
      run = await options.gatewayStore.getRun(claims.runId);
    } catch {
      return errorResponse(401, "invalid_run", "run is not available");
    }
    if (run.status !== "active") {
      if (run.status === "limit-hit") {
        return errorResponse(429, "run_spend_limit", "run spend limit reached");
      }
      return errorResponse(401, "inactive_run", "run is not active");
    }

    if (!rateLimiter.consume(token)) {
      await safeRefusal(options.callStore, claims.runId, request, "rate-limit", clock);
      return errorResponse(429, "rate_limit", "run request rate limit reached");
    }

    const path = new URL(request.url).pathname;
    const route = getHarnessRoute(request.method, path, options.config);
    if (!route) {
      await safeRefusal(options.callStore, claims.runId, request, "unknown-route", clock);
      return errorResponse(404, "route_not_found", "route is not supported");
    }
    if (!route.enabled) {
      await safeRefusal(options.callStore, claims.runId, request, "route-disabled", clock);
      return errorResponse(404, "route_not_found", "route is not enabled");
    }

    let body: Record<string, unknown>;
    try {
      body = await readJsonBodyWithinLimit(request, options.config.maxBodyBytes);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        await safeRefusal(options.callStore, claims.runId, request, "body-too-large", clock);
        return errorResponse(413, "request_too_large", "request body is too large");
      }
      await safeRefusal(options.callStore, claims.runId, request, "invalid-body", clock);
      return errorResponse(400, "invalid_request", "request body is invalid");
    }

    const model = body[route.modelField];
    if (typeof model !== "string" || !run.allowedModels.includes(model)) {
      await safeRefusal(options.callStore, claims.runId, request, "model-not-allowed", clock);
      return errorResponse(400, "model_not_allowed", "model is not allowed for this run");
    }

    if (requestsStreaming(request, body)) {
      await safeRefusal(
        options.callStore,
        claims.runId,
        request,
        "streaming-not-implemented",
        clock,
      );
      return errorResponse(
        501,
        "streaming_not_implemented",
        "streaming is not available in this gateway build",
      );
    }

    return await options.dispatch({
      request,
      token,
      claims,
      run,
      route,
      body,
    });
  };
}

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
  readonly signal?: AbortSignal;
};

export type HarnessSettlement = {
  readonly costUsd: number;
};

export type HarnessOutboundResponse = {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array | ReadableStream<Uint8Array>;
  readonly settlement?: Promise<HarnessSettlement>;
};

export type HarnessDispatchRequest = {
  readonly run: GatewayRunRecord;
  readonly route: HarnessRouteSpec;
  readonly requestHeaders: HarnessHeaders;
  readonly body: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
  readonly callId: string;
  readonly provider: "openai" | "anthropic";
  readonly model: string;
  readonly modelSettings: Readonly<Record<string, unknown>>;
};

export type HarnessDispatch = (
  request: HarnessDispatchRequest,
) => Promise<HarnessOutboundResponse>;

export type HarnessCostEstimator = (
  request: HarnessDispatchRequest,
) => Promise<number>;

export type HarnessPendingCostReconciler = (
  run: GatewayRunRecord,
  callId: string,
) => Promise<unknown>;

export type HarnessHttpHandlerOptions = {
  readonly config: HarnessHttpConfig;
  readonly tokenService: RunTokenService;
  readonly gatewayStore: GatewayStore;
  readonly callStore: HarnessCallStore;
  readonly rateLimiter: RunTokenBucket;
  readonly dispatch: HarnessDispatch;
  /** Conservative list-price reservation estimate for one paid request. */
  readonly estimateCostUsd?: HarnessCostEstimator;
  /** Resolves a persisted paid call whose authoritative cost is still pending. */
  readonly reconcilePendingCall?: HarnessPendingCostReconciler;
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

async function recordedRunSpend(
  runId: string,
  gatewayStore: GatewayStore,
  callStore: HarnessCallStore,
  reservedCallIds: ReadonlySet<string>,
): Promise<{
  readonly costUsd: number;
  readonly pendingCallIds: readonly string[];
}> {
  const [directCosts, harnessCalls] = await Promise.all([
    gatewayStore.listCostRecords(runId),
    callStore.listCalls(runId),
  ]);

  let costUsd = 0;
  for (const record of directCosts) {
    if (!Number.isFinite(record.listPriceCostUsd) || record.listPriceCostUsd < 0) {
      throw new Error("stored direct-call cost is invalid");
    }
    costUsd += record.listPriceCostUsd;
  }

  const pendingCallIds: string[] = [];
  for (const call of harnessCalls) {
    if (!call.paid) continue;
    if (call.costPending && !reservedCallIds.has(call.callId)) {
      pendingCallIds.push(call.callId);
    }
    if (call.listPriceCostUsd === null || reservedCallIds.has(call.callId)) continue;
    if (!Number.isFinite(call.listPriceCostUsd) || call.listPriceCostUsd < 0) {
      throw new Error("stored harness-call cost is invalid");
    }
    costUsd += call.listPriceCostUsd;
  }

  return { costUsd, pendingCallIds };
}

async function appendRefusal(
  options: HarnessHttpHandlerOptions,
  runId: string,
  method: string,
  path: string,
  reason: string,
  timestampMs: number,
): Promise<void> {
  await options.callStore.appendRefusal({
    runId,
    refusalId: randomUUID(),
    timestampMs,
    method: method.toUpperCase(),
    path,
    reason,
  });
}

async function withRunLock<T>(
  locks: Map<string, Promise<void>>,
  runId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = locks.get(runId) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  locks.set(runId, tail);

  await previous;
  try {
    return await operation();
  } finally {
    release?.();
    if (locks.get(runId) === tail) locks.delete(runId);
  }
}

export function createHarnessHttpHandler(options: HarnessHttpHandlerOptions) {
  const clock = options.clock ?? Date.now;
  const paidRunLocks = new Map<string, Promise<void>>();
  const reservations = new Map<string, Map<string, number>>();

  const reservationMap = (runId: string): Map<string, number> => {
    let active = reservations.get(runId);
    if (!active) {
      active = new Map<string, number>();
      reservations.set(runId, active);
    }
    return active;
  };

  const releaseReservation = async (runId: string, callId: string) => {
    await withRunLock(paidRunLocks, runId, async () => {
      const active = reservationMap(runId);
      active.delete(callId);
      if (active.size === 0) reservations.delete(runId);

      let current: GatewayRunRecord;
      try {
        current = await options.gatewayStore.getRun(runId);
      } catch {
        return;
      }
      if (current.status !== "active") return;
      try {
        const spend = await recordedRunSpend(
          runId,
          options.gatewayStore,
          options.callStore,
          new Set(active.keys()),
        );
        if (spend.costUsd >= current.spendCapUsd) {
          await options.gatewayStore.saveRun({ ...current, status: "limit-hit" });
        }
      } catch {
        // The next paid request will fail closed while re-reading spend state.
      }
    });
  };

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
      await appendRefusal(
        options,
        run.runId,
        request.method,
        path,
        route ? "disabled-route" : "unknown-route",
        clock(),
      );
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
      await appendRefusal(
        options,
        run.runId,
        request.method,
        path,
        "streaming-not-available",
        clock(),
      );
      return jsonError(
        400,
        "streaming_not_available",
        "streaming is not enabled for this route",
      );
    }

    const model = getModel(body, route);
    if (!model || !run.allowedModels.includes(model)) {
      await appendRefusal(
        options,
        run.runId,
        request.method,
        path,
        "model-not-allowed",
        clock(),
      );
      return jsonError(400, "model_not_allowed", "requested model is not allowed");
    }

    const callId = randomUUID();
    const makeDispatchRequest = (activeRun: GatewayRunRecord): HarnessDispatchRequest => ({
      run: activeRun,
      route,
      requestHeaders: request.headers,
      body,
      ...(request.signal ? { signal: request.signal } : {}),
      callId,
      provider: providerFor(route),
      model,
      modelSettings: safeModelSettings(body, route),
    });

    if (!route.paid) return await options.dispatch(makeDispatchRequest(run));

    if (!options.estimateCostUsd) {
      return jsonError(
        500,
        "spend_estimator_unavailable",
        "paid request cost estimator is unavailable",
      );
    }
    if (!options.reconcilePendingCall) {
      return jsonError(
        500,
        "spend_reconciler_unavailable",
        "paid request spend reconciler is unavailable",
      );
    }

    let estimate: number;
    try {
      estimate = await options.estimateCostUsd(makeDispatchRequest(run));
    } catch {
      return jsonError(500, "spend_estimate_error", "request spend estimate failed");
    }
    if (!Number.isFinite(estimate) || estimate < 0) {
      return jsonError(500, "spend_estimate_error", "request spend estimate is invalid");
    }

    let reservedRun: GatewayRunRecord | null = null;
    while (!reservedRun) {
      const decision = await withRunLock(paidRunLocks, run.runId, async () => {
        let current: GatewayRunRecord;
        try {
          current = await options.gatewayStore.getRun(run.runId);
        } catch {
          return { response: jsonError(401, "unauthorized", "run is not available") } as const;
        }

        if (current.status === "limit-hit") {
          return {
            response: jsonError(429, "spend_limit", "run spend limit has been reached"),
          } as const;
        }
        if (current.status !== "active" || clock() >= current.expiresAtMs) {
          return {
            response: jsonError(401, "inactive_run", "run is not active"),
          } as const;
        }
        if (!current.allowedModels.includes(model)) {
          return {
            response: jsonError(400, "model_not_allowed", "requested model is not allowed"),
          } as const;
        }

        const active = reservationMap(current.runId);
        let spend;
        try {
          spend = await recordedRunSpend(
            current.runId,
            options.gatewayStore,
            options.callStore,
            new Set(active.keys()),
          );
        } catch {
          return {
            response: jsonError(500, "spend_state_error", "run spend state is unavailable"),
          } as const;
        }

        if (spend.costUsd >= current.spendCapUsd) {
          await options.gatewayStore.saveRun({ ...current, status: "limit-hit" });
          return {
            response: jsonError(429, "spend_limit", "run spend limit has been reached"),
          } as const;
        }
        if (spend.pendingCallIds.length > 0) {
          return { run: current, pendingCallIds: spend.pendingCallIds } as const;
        }

        let reservedUsd = 0;
        for (const amount of active.values()) reservedUsd += amount;
        if (spend.costUsd + reservedUsd + estimate > current.spendCapUsd) {
          return {
            response: jsonError(
              429,
              "spend_reserved",
              "run spend is temporarily reserved by in-flight paid calls",
            ),
          } as const;
        }
        active.set(callId, estimate);
        return { run: current, pendingCallIds: [] as const };
      });

      if ("response" in decision) return decision.response;
      if (decision.pendingCallIds.length > 0) {
        try {
          await Promise.all(
            decision.pendingCallIds.map(
              async (pendingCallId) =>
                await options.reconcilePendingCall!(decision.run, pendingCallId),
            ),
          );
        } catch {
          return jsonError(
            503,
            "spend_reconciliation_pending",
            "a prior paid call could not be reconciled within the bounded retry window",
          );
        }
        continue;
      }
      reservedRun = decision.run;
    }

    let response: HarnessOutboundResponse;
    try {
      response = await options.dispatch(makeDispatchRequest(reservedRun));
    } catch {
      await releaseReservation(reservedRun.runId, callId);
      return jsonError(502, "upstream_error", "model gateway dispatch failed");
    }

    const settlement =
      response.settlement ??
      (async (): Promise<HarnessSettlement> => {
        let call = await options.callStore.getCall(reservedRun!.runId, callId);
        if (call.costPending) {
          await options.reconcilePendingCall!(reservedRun!, callId);
          call = await options.callStore.getCall(reservedRun!.runId, callId);
        }
        if (call.listPriceCostUsd === null) {
          throw new Error("paid harness call completed without settled cost");
        }
        return { costUsd: call.listPriceCostUsd };
      })();

    void settlement.then(
      async () => await releaseReservation(reservedRun!.runId, callId),
      async () => await releaseReservation(reservedRun!.runId, callId),
    );

    return response;
  };
}

import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { FileGatewayStore } from "../file-store.js";
import { RunTokenService } from "../run-token.js";
import { createListPriceCostEstimator, parseModelListPrices, type ModelListPrices } from "./cost-estimator.js";
import { FileHarnessCallStore } from "./file-store.js";
import {
  createHarnessHttpHandler,
  type HarnessHeaders,
  type HarnessInboundRequest,
  type HarnessOutboundResponse,
} from "./handler.js";
import { LiteLLMSpendClient } from "./litellm-spend.js";
import { loadHarnessHttpConfig } from "./config.js";
import { RunTokenBucket } from "./rate-limiter.js";
import { HarnessSpendReconciler } from "./reconciler.js";
import { LiteLLMHarnessTransport } from "./upstream.js";

export type GatewayServerConfig = {
  readonly host: string;
  readonly port: number;
  readonly drainTimeoutMs: number;
  readonly runTokenSecret: string;
  readonly litellmGatewayUrl: string;
  readonly litellmAdminToken: string;
  readonly gatewayStoreDir: string;
  readonly harnessCallStoreDir: string;
  readonly modelPrices: ModelListPrices;
};

export type GatewayServerRuntime = {
  readonly server: Server;
  listen(): Promise<void>;
  closeGracefully(): Promise<void>;
};

function requiredEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integerEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function loadGatewayServerConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): GatewayServerConfig {
  const runTokenSecret = requiredEnv(env, "MODEL_GATEWAY_RUN_TOKEN_SECRET");
  const litellmGatewayUrl = requiredEnv(env, "LITELLM_GATEWAY_URL");
  const litellmAdminToken = requiredEnv(env, "LITELLM_ADMIN_TOKEN");
  const gatewayStoreDir = requiredEnv(env, "GATEWAY_STORE_DIR");
  const harnessCallStoreDir = requiredEnv(env, "HARNESS_CALL_STORE_DIR");
  const pricesJson = requiredEnv(env, "HARNESS_MODEL_PRICES_JSON");

  return {
    host: env.HTTP_GATEWAY_HOST?.trim() || "127.0.0.1",
    port: integerEnv(env, "HTTP_GATEWAY_PORT", 8080, 65_535),
    drainTimeoutMs: integerEnv(env, "HTTP_GATEWAY_DRAIN_TIMEOUT_MS", 30_000),
    runTokenSecret,
    litellmGatewayUrl,
    litellmAdminToken,
    gatewayStoreDir,
    harnessCallStoreDir,
    modelPrices: parseModelListPrices(pricesJson),
  };
}

function headersFromNode(headers: IncomingHttpHeaders): HarnessHeaders {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string") result[name] = value;
    else if (Array.isArray(value)) result[name] = value.join(", ");
  }
  return result;
}

async function* bodyFromNode(request: IncomingMessage): AsyncIterable<Uint8Array> {
  for await (const chunk of request) {
    yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
  }
}

function applyHeaders(
  response: HarnessOutboundResponse,
  target: ServerResponse,
): void {
  for (const [name, value] of Object.entries(response.headers)) {
    target.setHeader(name, value);
  }
}

async function writeHarnessResponse(
  response: HarnessOutboundResponse,
  target: ServerResponse,
): Promise<void> {
  target.statusCode = response.status;
  applyHeaders(response, target);
  if (response.body instanceof Uint8Array) {
    target.end(Buffer.from(response.body));
    return;
  }

  const reader = response.body.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (!target.write(Buffer.from(next.value))) {
        await new Promise<void>((resolveDrain) => target.once("drain", resolveDrain));
      }
    }
    target.end();
  } catch {
    target.destroy();
  } finally {
    reader.releaseLock();
  }
}

function requestPath(request: IncomingMessage): string {
  return request.url ?? "/";
}

export function createGatewayServerRuntime(
  config: GatewayServerConfig,
): GatewayServerRuntime {
  const httpConfig = loadHarnessHttpConfig();
  const gatewayStore = new FileGatewayStore({ rootDir: config.gatewayStoreDir });
  const callStore = new FileHarnessCallStore({ rootDir: config.harnessCallStoreDir });
  const tokenService = new RunTokenService({ secret: config.runTokenSecret });
  const spendSource = new LiteLLMSpendClient({
    baseUrl: config.litellmGatewayUrl,
    adminToken: config.litellmAdminToken,
  });
  const reconciler = new HarnessSpendReconciler({
    callStore,
    spendSource,
    timeoutMs: httpConfig.limits.reconciliationTimeoutMs,
    initialDelayMs: httpConfig.limits.reconciliationInitialDelayMs,
    maxDelayMs: httpConfig.limits.reconciliationMaxDelayMs,
    costToleranceUsd: httpConfig.limits.costToleranceUsd,
  });
  const transport = new LiteLLMHarnessTransport({
    baseUrl: config.litellmGatewayUrl,
    gatewayStore,
    callStore,
    nonStreamingTimeoutMs: httpConfig.limits.nonStreamingTimeoutMs,
    firstResponseTimeoutMs: httpConfig.limits.firstResponseTimeoutMs,
    streamIdleTimeoutMs: httpConfig.limits.streamIdleTimeoutMs,
    maxStreamDurationMs: httpConfig.limits.maxStreamDurationMs,
    spendReconciler: reconciler,
  });
  const handler = createHarnessHttpHandler({
    config: httpConfig,
    tokenService,
    gatewayStore,
    callStore,
    rateLimiter: new RunTokenBucket({
      ratePerMinute: httpConfig.limits.ratePerMinute,
      burst: httpConfig.limits.rateBurst,
    }),
    dispatch: async (request) => await transport.forward(request),
    estimateCostUsd: createListPriceCostEstimator(config.modelPrices),
    reconcilePendingCall: async (run, callId) => await reconciler.reconcileCall(run, callId),
  });

  const activeControllers = new Set<AbortController>();
  let closing: Promise<void> | null = null;

  const server = createServer(async (request, response) => {
    const controller = new AbortController();
    activeControllers.add(controller);
    const onClose = () => {
      if (!response.writableEnded) controller.abort();
    };
    request.once("aborted", onClose);
    response.once("close", onClose);

    try {
      const inbound: HarnessInboundRequest = {
        method: request.method ?? "GET",
        path: requestPath(request),
        headers: headersFromNode(request.headers),
        body: bodyFromNode(request),
        signal: controller.signal,
      };
      const outgoing = await handler(inbound);
      await writeHarnessResponse(outgoing, response);
    } catch {
      if (!response.headersSent) {
        response.statusCode = 500;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ error: { code: "gateway_error", message: "gateway request failed" } }));
      } else {
        response.destroy();
      }
    } finally {
      request.off("aborted", onClose);
      response.off("close", onClose);
      activeControllers.delete(controller);
    }
  });

  const listen = async (): Promise<void> => {
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.host, () => resolveListen());
    });
  };

  const closeGracefully = async (): Promise<void> => {
    if (closing) return await closing;
    closing = (async () => {
      const closed = new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      if (activeControllers.size === 0) {
        await closed;
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<"deadline">((resolveDeadline) => {
        timer = setTimeout(() => resolveDeadline("deadline"), config.drainTimeoutMs);
      });
      const result = await Promise.race([closed.then(() => "closed" as const), deadline]);
      if (timer) clearTimeout(timer);
      if (result === "deadline") {
        for (const controller of activeControllers) controller.abort();
        server.closeAllConnections();
        await closed;
      }
    })();
    return await closing;
  };

  return { server, listen, closeGracefully };
}

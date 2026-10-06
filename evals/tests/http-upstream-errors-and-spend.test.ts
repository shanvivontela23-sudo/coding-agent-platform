import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileGatewayStore, RunTokenService } from "../src/gateway/index.js";
import {
  FileHarnessCallStore,
  LiteLLMHarnessTransport,
  RunTokenBucket,
  createHarnessHttpHandler,
  loadHarnessHttpConfig,
  type HarnessCallRecord,
} from "../src/gateway/http/index.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function body(value: unknown) {
  return (async function* () {
    yield Buffer.from(JSON.stringify(value));
  })();
}

function emptyUsage() {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  } as const;
}

function responseBytes(responseBody: Uint8Array | ReadableStream<Uint8Array>): Uint8Array {
  if (responseBody instanceof ReadableStream) {
    throw new Error("expected a non-streaming response body");
  }
  return responseBody;
}

async function setup(
  fetchImpl: typeof fetch,
  spendCapUsd = 10,
  settlePendingInline = false,
) {
  const root = await mkdtemp(join(tmpdir(), "coding-agent-http-upstream-"));
  roots.push(root);
  const gatewayStore = new FileGatewayStore({ rootDir: join(root, "gateway") });
  const callStore = new FileHarnessCallStore({ rootDir: join(root, "http") });
  const tokenService = new RunTokenService({
    secret: "test-secret-that-is-long-enough-for-hmac",
    clock: () => 1_000,
  });
  await gatewayStore.createRun({
    runId: "run-1",
    expiresAtMs: 10_000,
    spendCapUsd,
    upstreamCredential: "run-litellm-secret",
    allowedModels: ["primary-model"],
    status: "active",
  });
  const token = tokenService.issue("run-1", 10_000);
  const transport = new LiteLLMHarnessTransport({
    baseUrl: "https://litellm.example.com",
    fetch: fetchImpl,
    gatewayStore,
    callStore,
    nonStreamingTimeoutMs: 500,
    clock: () => 1_000,
  });
  let reconciliations = 0;
  const handler = createHarnessHttpHandler({
    config: loadHarnessHttpConfig(),
    tokenService,
    gatewayStore,
    callStore,
    rateLimiter: new RunTokenBucket({
      ratePerMinute: 120,
      burst: 20,
      clock: () => 1_000,
    }),
    clock: () => 1_000,
    estimateCostUsd: async () => 0.01,
    reconcilePendingCall: async (run, callId) => {
      reconciliations += 1;
      if (!settlePendingInline) {
        throw new Error("spend log row not available in this fixture");
      }
      const record = await callStore.getCall(run.runId, callId);
      await callStore.saveCall({
        ...record,
        listPriceCostUsd: 0.02,
        costPending: false,
        updatedAtMs: 1_000,
      });
    },
    dispatch: (request) => transport.forward(request),
  });
  return {
    callStore,
    gatewayStore,
    handler,
    token,
    getReconciliations: () => reconciliations,
  };
}

function inbound(token: string) {
  return {
    method: "POST",
    path: "/v1/responses",
    headers: { authorization: `Bearer ${token}` },
    body: body({ model: "primary-model", input: "x" }),
  } as const;
}

function completedHarnessCall(cost: number): HarnessCallRecord {
  return {
    runId: "run-1",
    callId: "prior-harness-call",
    method: "POST",
    path: "/v1/responses",
    wireApi: "responses",
    provider: "openai",
    model: "primary-model",
    modelSettings: {},
    paid: true,
    state: "completed",
    usage: emptyUsage(),
    latencyMs: 10,
    litellmCallId: "prior-harness-call",
    listPriceCostUsd: cost,
    costPending: false,
    createdAtMs: 900,
    updatedAtMs: 900,
  };
}

describe("P0-05 upstream errors and spend enforcement", () => {
  it("recognizes LiteLLM v1.103.2 budget_exceeded by explicit error type regardless of HTTP status", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: {
            message: "Budget has been exceeded! Current cost: 1.1, Max budget: 1.0",
            type: "budget_exceeded",
            param: null,
            code: "400",
          },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
    );
    const { gatewayStore, handler, token } = await setup(fetchMock as typeof fetch);

    const response = await handler(inbound(token));

    expect(response.status).toBe(400);
    expect((await gatewayStore.getRun("run-1")).status).toBe("limit-hit");
  });

  it("does not classify a provider rate-limit 429 as a run spend limit", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: {
            message: "litellm.RateLimitError: OpenAIException - rate limit reached",
            type: "throttling_error",
            param: null,
            code: "429",
          },
        }),
        {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "7" },
        },
      ),
    );
    const { callStore, gatewayStore, handler, token } = await setup(
      fetchMock as typeof fetch,
    );

    const response = await handler(inbound(token));
    const [call] = await callStore.listCalls("run-1");

    expect(response.status).toBe(429);
    expect(response.headers["retry-after"]).toBe("7");
    expect(JSON.parse(Buffer.from(responseBytes(response.body)).toString("utf8"))).toEqual({
      error: {
        message: "litellm.RateLimitError: OpenAIException - rate limit reached",
        type: "throttling_error",
        param: null,
        code: "429",
      },
    });
    expect(call).toMatchObject({
      state: "failed",
      usage: emptyUsage(),
      zeroCostIfSpendMissing: true,
    });
    expect((await gatewayStore.getRun("run-1")).status).toBe("active");
  });

  it("passes through a sanitized context-length error with the upstream status", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: {
            message: "maximum context length exceeded; Bearer should-not-leak",
            type: "invalid_request_error",
            param: "input",
            code: "context_length_exceeded",
            internal_debug: "drop-me",
          },
          trace: "drop-me-too",
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
    );
    const { callStore, handler, token } = await setup(fetchMock as typeof fetch);

    const response = await handler(inbound(token));
    const responseBody = Buffer.from(responseBytes(response.body)).toString("utf8");
    const [call] = await callStore.listCalls("run-1");

    expect(response.status).toBe(400);
    expect(responseBody).not.toContain("should-not-leak");
    expect(responseBody).not.toContain("drop-me");
    expect(JSON.parse(responseBody)).toEqual({
      error: {
        message: "maximum context length exceeded; [redacted]",
        type: "invalid_request_error",
        param: "input",
        code: "context_length_exceeded",
      },
    });
    expect(call).toMatchObject({
      state: "failed",
      usage: emptyUsage(),
      zeroCostIfSpendMissing: true,
    });
  });

  it("passes through an overloaded response and retry-after", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: {
            message: "provider overloaded",
            type: "overloaded_error",
            param: null,
            code: "503",
          },
        }),
        {
          status: 503,
          headers: { "content-type": "application/json", "retry-after": "2" },
        },
      ),
    );
    const { handler, token } = await setup(fetchMock as typeof fetch);

    const response = await handler(inbound(token));

    expect(response.status).toBe(503);
    expect(response.headers["retry-after"]).toBe("2");
    expect(
      JSON.parse(Buffer.from(responseBytes(response.body)).toString("utf8")),
    ).toMatchObject({ error: { type: "overloaded_error", code: "503" } });
  });

  it("refuses before dispatch when direct plus harness recorded cost has reached the run cap", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ id: "must-not-run", usage: {} }), {
        status: 200,
        headers: { "x-litellm-response-cost": "0.01" },
      }),
    );
    const { callStore, gatewayStore, handler, token } = await setup(
      fetchMock as typeof fetch,
      1,
    );
    await gatewayStore.saveStoredCall("run-1", "control-plane-call", {
      requestHash: "hash",
      response: {},
      costRecord: {
        runId: "run-1",
        idempotencyKey: "control-plane-call",
        provider: "openai",
        model: "primary-model",
        modelSettings: {},
        ...emptyUsage(),
        latencyMs: 10,
        listPriceCostUsd: 0.6,
        createdAtMs: 800,
      },
    });
    await callStore.createCall(completedHarnessCall(0.4));

    const response = await handler(inbound(token));

    expect(response.status).toBe(429);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await gatewayStore.getRun("run-1")).status).toBe("limit-hit");
  });

  it("returns a successful paid response without cost header and marks its cost pending reconciliation", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: "resp",
          usage: { input_tokens: 2, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const { callStore, handler, token } = await setup(fetchMock as typeof fetch);

    const response = await handler(inbound(token));
    const [record] = await callStore.listCalls("run-1");

    expect(response.status).toBe(200);
    expect(record).toMatchObject({
      state: "completed",
      listPriceCostUsd: null,
      costPending: true,
    });
  });

  it("reconciles a prior pending call inline and then allows the next paid dispatch", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: "resp",
          usage: { input_tokens: 2, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const { handler, token, getReconciliations } = await setup(
      fetchMock as typeof fetch,
      10,
      true,
    );

    expect((await handler(inbound(token))).status).toBe(200);
    const second = await handler(inbound(token));

    expect(second.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getReconciliations()).toBeGreaterThanOrEqual(1);
  });
});

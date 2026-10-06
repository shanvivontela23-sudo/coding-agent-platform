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
  type HarnessInboundRequest,
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

async function setup(fetchImpl: typeof fetch, timeoutMs = 500) {
  const root = await mkdtemp(join(tmpdir(), "coding-agent-http-nonstream-"));
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
    spendCapUsd: 10,
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
    nonStreamingTimeoutMs: timeoutMs,
    clock: () => 1_000,
  });
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
    dispatch: (request) => transport.forward(request),
  });
  return { callStore, gatewayStore, handler, token };
}

function inbound(
  token: string,
  payload: Readonly<Record<string, unknown>>,
  path = "/v1/responses",
): HarnessInboundRequest {
  return {
    method: "POST",
    path,
    headers: {
      authorization: `Bearer ${token}`,
      "x-api-key": token,
      "idempotency-key": "client-replay-key",
      "content-type": "application/json",
      "openai-project": "project-safe",
    },
    body: body(payload),
  };
}

describe("non-streaming harness LiteLLM proxy", () => {
  it("strips client credentials/idempotency, injects run key, and records each identical request separately", async () => {
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) =>
      new Response(
        JSON.stringify({
          id: "resp",
          usage: {
            input_tokens: 10,
            output_tokens: 3,
            input_tokens_details: { cached_tokens: 2 },
            output_tokens_details: { reasoning_tokens: 1 },
          },
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-litellm-response-cost": "0.05",
            "x-litellm-call-id": String(
              (init?.headers as Record<string, string>)["x-litellm-call-id"],
            ),
          },
        },
      ),
    );
    const { callStore, handler, token } = await setup(fetchMock as typeof fetch);

    const first = await handler(
      inbound(token, { model: "primary-model", input: "same" }),
    );
    const second = await handler(
      inbound(token, { model: "primary-model", input: "same" }),
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const calls = await callStore.listCalls("run-1");
    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((call) => call.callId)).size).toBe(2);

    for (const [, init] of fetchMock.mock.calls) {
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer run-litellm-secret");
      expect(headers["x-api-key"]).toBeUndefined();
      expect(headers["Idempotency-Key"]).toBeUndefined();
      expect(headers["idempotency-key"]).toBeUndefined();
      expect(headers["x-litellm-call-id"]).toBeTruthy();
    }
    expect(JSON.stringify(first.headers)).not.toContain("run-litellm-secret");
  });

  it("marks a run limit-hit only for LiteLLM's explicit budget_exceeded error type", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: {
            message: "Budget has been exceeded! Current cost: 10, Max budget: 10",
            type: "budget_exceeded",
            param: null,
            code: "429",
          },
        }),
        {
          status: 429,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    const { gatewayStore, handler, token } = await setup(fetchMock as typeof fetch);

    const response = await handler(
      inbound(token, { model: "primary-model", input: "x" }),
    );
    expect(response.status).toBe(429);
    expect((await gatewayStore.getRun("run-1")).status).toBe("limit-hit");

    const again = await handler(
      inbound(token, { model: "primary-model", input: "x" }),
    );
    expect(again.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("records token-count calls at zero cost", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ input_tokens: 123 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const { callStore, handler, token } = await setup(fetchMock as typeof fetch);
    const response = await handler(
      inbound(
        token,
        { model: "primary-model", messages: [] },
        "/v1/messages/count_tokens",
      ),
    );

    expect(response.status).toBe(200);
    const [record] = await callStore.listCalls("run-1");
    expect(record).toMatchObject({
      paid: false,
      state: "completed",
      listPriceCostUsd: 0,
      costPending: false,
    });
  });

  it("times out non-streaming upstream work and records the call as timeout", async () => {
    const fetchMock = vi.fn(
      (_url: string | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const { callStore, handler, token } = await setup(
      fetchMock as typeof fetch,
      5,
    );

    const response = await handler(
      inbound(token, { model: "primary-model", input: "x" }),
    );
    expect(response.status).toBe(504);
    const [record] = await callStore.listCalls("run-1");
    expect(record?.state).toBe("timeout");
  });

  it("records an ordinary upstream network failure as failed, not interrupted", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("network unavailable");
    });
    const { callStore, handler, token } = await setup(fetchMock as typeof fetch);

    const response = await handler(
      inbound(token, { model: "primary-model", input: "x" }),
    );

    expect(response.status).toBe(502);
    const [record] = await callStore.listCalls("run-1");
    expect(record?.state).toBe("failed");
  });
});

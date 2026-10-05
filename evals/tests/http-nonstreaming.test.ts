import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileGatewayStore, RunTokenService, type GatewayRunRecord } from "../src/gateway/index.js";
import { loadHarnessHttpConfig } from "../src/gateway/http/config.js";
import { FileHarnessCallStore } from "../src/gateway/http/file-store.js";
import { createHarnessHttpHandler } from "../src/gateway/http/handler.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function loadUpstreamModule() {
  const path = "../src/gateway/http/upstream.js";
  return await import(path).catch(() => ({} as Record<string, unknown>));
}

async function setup(fetchImpl: typeof fetch, timeoutMs = 600_000) {
  const root = await mkdtemp(join(tmpdir(), "http-nonstream-"));
  roots.push(root);
  const gatewayStore = new FileGatewayStore({ rootDir: join(root, "gateway") });
  const callStore = new FileHarnessCallStore({ rootDir: join(root, "http") });
  const run: GatewayRunRecord = {
    runId: "run-a",
    expiresAtMs: 10_000,
    spendCapUsd: 10,
    upstreamCredential: "litellm-run-secret",
    allowedModels: ["primary-model", "background-model"],
    status: "active",
  };
  await gatewayStore.createRun(run);
  const tokens = new RunTokenService({
    secret: "test-secret-that-is-long-enough-for-hmac",
    clock: () => 1_000,
  });
  const token = tokens.issue("run-a", 10_000);
  const config = { ...(await loadHarnessHttpConfig()), nonStreamingTimeoutMs: timeoutMs };
  const module = await loadUpstreamModule();
  expect(typeof module.LiteLLMHarnessTransport).toBe("function");
  expect(typeof module.createNonStreamingHarnessDispatcher).toBe("function");
  const Transport = module.LiteLLMHarnessTransport as new (options: {
    baseUrl: string;
    fetch: typeof fetch;
  }) => unknown;
  const transport = new Transport({
    baseUrl: "https://litellm.example.com",
    fetch: fetchImpl,
  });
  const dispatch = (module.createNonStreamingHarnessDispatcher as (options: unknown) => (input: unknown) => Promise<Response>)({
    transport,
    gatewayStore,
    callStore,
    config,
    clock: () => 1_000,
  });
  const handle = createHarnessHttpHandler({
    tokenService: tokens,
    gatewayStore,
    callStore,
    config,
    dispatch,
    clock: () => 1_000,
  });
  return { gatewayStore, callStore, token, handle };
}

function request(path: string, token: string, body: Record<string, unknown>) {
  return new Request(`https://gateway.example.com${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "x-api-key": token,
      "idempotency-key": "client-key-must-be-stripped",
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
  });
}

function openAiBody(id: string) {
  return JSON.stringify({
    id,
    model: "primary-model",
    output: [{ type: "message", content: [] }],
    usage: {
      input_tokens: 20,
      output_tokens: 5,
      input_tokens_details: { cached_tokens: 2 },
      output_tokens_details: { reasoning_tokens: 1 },
    },
  });
}

function openAiResponse(id: string) {
  return new Response(openAiBody(id), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-litellm-response-cost": "0.0123",
      "x-upstream-secret": "must-not-return",
    },
  });
}

describe("P0-05 non-streaming harness proxy", () => {
  it("strips client credentials/idempotency and never replays identical harness requests", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      seen.push({ url: String(input), init: init ?? {} });
      return openAiResponse(`response-${seen.length}`);
    }) as unknown as typeof fetch;
    const { callStore, token, handle } = await setup(fetchMock);

    const first = await handle(request("/v1/responses", token, { model: "primary-model", input: "hello" }));
    const second = await handle(request("/v1/responses", token, { model: "primary-model", input: "hello" }));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(seen).toHaveLength(2);
    const callIds = seen.map(({ init }) => new Headers(init.headers).get("x-litellm-call-id"));
    expect(callIds[0]).toBeTruthy();
    expect(callIds[1]).toBeTruthy();
    expect(callIds[0]).not.toBe(callIds[1]);
    for (const { init } of seen) {
      const headers = new Headers(init.headers);
      expect(headers.get("authorization")).toBe("Bearer litellm-run-secret");
      expect(headers.has("x-api-key")).toBe(false);
      expect(headers.has("idempotency-key")).toBe(false);
    }
    expect(first.headers.has("x-upstream-secret")).toBe(false);
    const records = await callStore.listCalls("run-a");
    expect(records).toHaveLength(2);
    expect(records.every((record) => record.state === "completed")).toBe(true);
    expect(records.map((record) => record.callId).sort()).toEqual(callIds.filter((id): id is string => id !== null).sort());
  });

  it("records token counting as a zero-cost non-paid call", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ input_tokens: 123 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;
    const { callStore, token, handle } = await setup(fetchMock);

    const response = await handle(
      request("/v1/messages/count_tokens", token, {
        model: "primary-model",
        messages: [{ role: "user", content: "hello" }],
      }),
    );

    expect(response.status).toBe(200);
    const [record] = await callStore.listCalls("run-a");
    expect(record).toMatchObject({
      paid: false,
      state: "completed",
      listPriceCostUsd: 0,
      usage: {
        inputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
      },
    });
  });

  it("marks timed-out upstream work for later reconciliation", async () => {
    const fetchMock = vi.fn((_input: string | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      }),
    ) as unknown as typeof fetch;
    const { callStore, token, handle } = await setup(fetchMock, 5);

    const response = await handle(request("/v1/responses", token, { model: "primary-model", input: "hello" }));

    expect(response.status).toBe(504);
    const [record] = await callStore.listCalls("run-a");
    expect(record?.state).toBe("timeout");
  });

  it("marks the run limit-hit on LiteLLM budget rejection and refuses later paid work", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: { type: "budget_exceeded", message: "max budget reached" } }), {
        status: 429,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;
    const { gatewayStore, callStore, token, handle } = await setup(fetchMock);

    const first = await handle(request("/v1/responses", token, { model: "primary-model", input: "hello" }));
    const second = await handle(request("/v1/responses", token, { model: "primary-model", input: "again" }));

    expect(first.status).toBe(429);
    expect(second.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await gatewayStore.getRun("run-a")).status).toBe("limit-hit");
    const [record] = await callStore.listCalls("run-a");
    expect(record?.state).toBe("rejected");
  });

  it("does not turn a generic provider rate limit into a permanent run spend limit", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: { type: "rate_limit_error", message: "rate limit reached" } }), {
        status: 429,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;
    const { gatewayStore, token, handle } = await setup(fetchMock);

    const response = await handle(request("/v1/responses", token, { model: "primary-model", input: "hello" }));

    expect(response.status).toBe(429);
    expect((await gatewayStore.getRun("run-a")).status).toBe("active");
  });

  it("fails closed if a successful paid response has no cost header", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(openAiBody("response-without-cost"), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;
    const { callStore, token, handle } = await setup(fetchMock);

    const response = await handle(request("/v1/responses", token, { model: "primary-model", input: "hello" }));

    expect(response.status).toBe(502);
    const [record] = await callStore.listCalls("run-a");
    expect(record).toMatchObject({
      state: "interrupted",
      listPriceCostUsd: null,
    });
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FileGatewayStore,
  LiteLLMAdapter,
  PersistentModelGateway,
  ProviderSpendLimitError,
  RunTokenService,
  type ModelCallRequest,
  type ModelProviderAdapter,
  type ProviderCallRequest,
  type ProviderCallResponse,
  type ProviderRunStartRequest,
} from "../src/gateway/index.js";

class MockAdapter implements ModelProviderAdapter {
  starts: ProviderRunStartRequest[] = [];
  calls: ProviderCallRequest[] = [];
  estimateUsd: number | null = 0;
  response: ProviderCallResponse = {
    body: { id: "response-1", output: "fixed" },
    usage: {
      inputTokens: 100,
      cachedInputTokens: 20,
      cacheWriteInputTokens: 5,
      outputTokens: 40,
      reasoningTokens: 10,
    },
    latencyMs: 250,
    listPriceCostUsd: 1.25,
  };

  async startRun(input: ProviderRunStartRequest) {
    this.starts.push(input);
    return { credential: `litellm-${input.runId}` };
  }

  async estimateMaxCostUsd() {
    return this.estimateUsd;
  }

  async call(input: ProviderCallRequest) {
    this.calls.push(input);
    return this.response;
  }
}

const tempDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function createStore() {
  const directory = await mkdtemp(join(tmpdir(), "coding-agent-gateway-"));
  tempDirectories.push(directory);
  return {
    directory,
    store: new FileGatewayStore({ rootDir: directory }),
  };
}

function request(
  runId = "run-1",
  idempotencyKey = "call-1",
): ModelCallRequest {
  return {
    runId,
    idempotencyKey,
    provider: "openai",
    model: "gpt-test",
    modelSettings: { temperature: 0, reasoning_effort: "high" },
    wireApi: "chat-completions",
    body: {
      messages: [{ role: "user", content: "Fix the bug" }],
      max_tokens: 200,
    },
  };
}

describe("P0-04 ModelGateway", () => {
  it("mints a token scoped to one run and rejects cross-run or expired use", async () => {
    const { store } = await createStore();
    let now = 1_000;
    const clock = () => now;
    const tokenService = new RunTokenService({
      secret: "test-secret-that-is-long-enough-for-hmac",
      clock,
    });
    const adapter = new MockAdapter();
    const gateway = new PersistentModelGateway({
      store,
      adapter,
      tokenService,
      clock,
    });

    const { token } = await gateway.startRun({
      runId: "run-1",
      expiresAtMs: 2_000,
    });

    await expect(gateway.call(token, request("run-2"))).rejects.toThrow(
      "run token is not valid for run-2",
    );

    now = 2_001;
    await expect(gateway.call(token, request("run-1"))).rejects.toThrow(
      "run token has expired",
    );
    expect(adapter.calls).toHaveLength(0);
  });

  it("records exactly one complete cost row and exposes totals for the Phase 0 result row", async () => {
    const { store } = await createStore();
    const tokenService = new RunTokenService({
      secret: "test-secret-that-is-long-enough-for-hmac",
      clock: () => 1_000,
    });
    const adapter = new MockAdapter();
    const gateway = new PersistentModelGateway({
      store,
      adapter,
      tokenService,
      clock: () => 1_000,
    });

    const { token } = await gateway.startRun({
      runId: "run-1",
      expiresAtMs: 10_000,
    });
    const response = await gateway.call(token, request());

    expect(response.costRecord).toMatchObject({
      runId: "run-1",
      provider: "openai",
      model: "gpt-test",
      modelSettings: { temperature: 0, reasoning_effort: "high" },
      inputTokens: 100,
      cachedInputTokens: 20,
      cacheWriteInputTokens: 5,
      outputTokens: 40,
      reasoningTokens: 10,
      latencyMs: 250,
      listPriceCostUsd: 1.25,
    });

    const records = await store.listCostRecords("run-1");
    expect(records).toHaveLength(1);
    const totals = await gateway.getRunCostSummary("run-1");
    expect(totals).toEqual({
      inputTokens: 100,
      cachedInputTokens: 20,
      cacheWriteInputTokens: 5,
      outputTokens: 40,
      reasoningTokens: 10,
      modelCostUsd: 1.25,
    });
  });

  it("survives a caller crash after provider response and replays without a second paid call", async () => {
    const { directory, store } = await createStore();
    const adapter = new MockAdapter();
    const tokenService = new RunTokenService({
      secret: "test-secret-that-is-long-enough-for-hmac",
      clock: () => 1_000,
    });
    const gateway = new PersistentModelGateway({
      store,
      adapter,
      tokenService,
      clock: () => 1_000,
    });

    const { token } = await gateway.startRun({
      runId: "run-1",
      expiresAtMs: 10_000,
    });
    const first = await gateway.call(token, request());
    expect(adapter.calls).toHaveLength(1);
    expect(first.replayed).toBe(false);

    // Simulate the caller crashing before it records its own step completion.
    // A new gateway process uses the same durable store.
    const restartedStore = new FileGatewayStore({ rootDir: directory });
    const restartedGateway = new PersistentModelGateway({
      store: restartedStore,
      adapter,
      tokenService,
      clock: () => 1_000,
    });
    const replay = await restartedGateway.call(token, request());

    expect(adapter.calls).toHaveLength(1);
    expect(replay.body).toEqual(first.body);
    expect(replay.costRecord).toEqual(first.costRecord);
    expect(replay.replayed).toBe(true);
    expect(await restartedStore.listCostRecords("run-1")).toHaveLength(1);
  });

  it("refuses a call whose reserved cost would exceed the default $10 cap and marks the run limit-hit", async () => {
    const { store } = await createStore();
    const adapter = new MockAdapter();
    adapter.response = {
      ...adapter.response,
      listPriceCostUsd: 9.5,
    };
    adapter.estimateUsd = 9.5;
    const tokenService = new RunTokenService({
      secret: "test-secret-that-is-long-enough-for-hmac",
      clock: () => 1_000,
    });
    const gateway = new PersistentModelGateway({
      store,
      adapter,
      tokenService,
      clock: () => 1_000,
    });

    const { token } = await gateway.startRun({
      runId: "run-1",
      expiresAtMs: 10_000,
    });
    await gateway.call(token, request("run-1", "call-1"));

    adapter.estimateUsd = 1;
    await expect(
      gateway.call(token, request("run-1", "call-2")),
    ).rejects.toThrow("run spend cap would be exceeded");

    expect(adapter.calls).toHaveLength(1);
    expect((await store.getRun("run-1")).status).toBe("limit-hit");
  });

  it("invalidates the run token when the run finishes", async () => {
    const { store } = await createStore();
    const tokenService = new RunTokenService({
      secret: "test-secret-that-is-long-enough-for-hmac",
      clock: () => 1_000,
    });
    const adapter = new MockAdapter();
    const gateway = new PersistentModelGateway({
      store,
      adapter,
      tokenService,
      clock: () => 1_000,
    });

    const { token } = await gateway.startRun({
      runId: "run-1",
      expiresAtMs: 10_000,
    });
    await gateway.finishRun("run-1");

    await expect(gateway.call(token, request())).rejects.toThrow(
      "run run-1 is not active",
    );
  });
});

describe("LiteLLM adapter", () => {
  it("creates a run-scoped virtual key and meters a response without exposing the admin credential", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ key: "sk-run-key" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "chatcmpl-1",
            model: "gpt-test",
            choices: [{ message: { role: "assistant", content: "done" } }],
            usage: {
              prompt_tokens: 120,
              completion_tokens: 50,
              prompt_tokens_details: { cached_tokens: 30 },
              completion_tokens_details: { reasoning_tokens: 12 },
            },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-litellm-response-cost": "0.42",
            },
          },
        ),
      );

    const adapter = new LiteLLMAdapter({
      baseUrl: "https://litellm.example.com",
      adminToken: "gateway-admin-secret",
      fetch: fetchMock,
      clock: () => 1_000,
    });

    const runCredential = await adapter.startRun({
      runId: "run-1",
      expiresAtMs: 61_000,
      spendCapUsd: 10,
    });
    expect(runCredential).toEqual({ credential: "sk-run-key" });

    const keyCall = fetchMock.mock.calls[0]!;
    const keyOptions = keyCall[1] as RequestInit;
    const keyHeaders = keyOptions.headers as Record<string, string>;
    expect(String(keyCall[0])).toBe("https://litellm.example.com/key/generate");
    expect(keyHeaders.Authorization).toBe("Bearer gateway-admin-secret");
    const keyBody = JSON.parse(String(keyOptions.body));
    expect(keyBody).toMatchObject({
      max_budget: 10,
      duration: "60s",
      metadata: { run_id: "run-1" },
    });

    const result = await adapter.call({
      ...request(),
      credential: "sk-run-key",
    });
    expect(result).toMatchObject({
      usage: {
        inputTokens: 120,
        cachedInputTokens: 30,
        cacheWriteInputTokens: 0,
        outputTokens: 50,
        reasoningTokens: 12,
      },
      listPriceCostUsd: 0.42,
    });

    const inferenceCall = fetchMock.mock.calls[1]!;
    const inferenceOptions = inferenceCall[1] as RequestInit;
    const inferenceHeaders = inferenceOptions.headers as Record<string, string>;
    expect(String(inferenceCall[0])).toBe(
      "https://litellm.example.com/v1/chat/completions",
    );
    expect(inferenceHeaders.Authorization).toBe("Bearer sk-run-key");
    const inferenceBody = String(inferenceOptions.body);
    expect(inferenceBody).not.toContain("gateway-admin-secret");
  });

  it("maps a LiteLLM budget rejection to a provider spend-limit error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "max budget reached" } }), {
        status: 429,
        headers: { "content-type": "application/json" },
      }),
    );
    const adapter = new LiteLLMAdapter({
      baseUrl: "https://litellm.example.com",
      adminToken: "gateway-admin-secret",
      fetch: fetchMock,
      clock: () => 1_000,
    });

    await expect(
      adapter.call({ ...request(), credential: "sk-run-key" }),
    ).rejects.toBeInstanceOf(ProviderSpendLimitError);
  });
});

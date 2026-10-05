import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FileGatewayStore,
  LiteLLMAdapter,
  PersistentModelGateway,
  RunTokenService,
  type ModelCallRequest,
  type ModelProviderAdapter,
  type ProviderCallRequest,
  type ProviderCallResponse,
  type ProviderRunCredential,
  type ProviderRunStartRequest,
} from "../src/gateway/index.js";

const tempDirectories: string[] = [];

class MockAdapter implements ModelProviderAdapter {
  readonly calls: ProviderCallRequest[] = [];

  async startRun(
    request: ProviderRunStartRequest,
  ): Promise<ProviderRunCredential> {
    return { credential: `credential-${request.runId}` };
  }

  async estimateMaxCostUsd(): Promise<number | null> {
    return 0;
  }

  async call(request: ProviderCallRequest): Promise<ProviderCallResponse> {
    this.calls.push(request);
    return {
      body: { id: `response-${this.calls.length}` },
      usage: {
        inputTokens: 10,
        cachedInputTokens: 2,
        cacheWriteInputTokens: 0,
        outputTokens: 3,
        reasoningTokens: 1,
      },
      latencyMs: 5,
      listPriceCostUsd: 0.1,
    };
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function createGateway() {
  const directory = await mkdtemp(join(tmpdir(), "coding-agent-hardening-"));
  tempDirectories.push(directory);
  const store = new FileGatewayStore({ rootDir: directory });
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
  return { directory, store, adapter, gateway };
}

function request(
  runId: string,
  idempotencyKey: string,
  body: Readonly<Record<string, unknown>> = {
    messages: [{ role: "user", content: "Fix the bug" }],
    max_tokens: 200,
  },
): ModelCallRequest {
  return {
    runId,
    idempotencyKey,
    provider: "openai",
    model: "gpt-test",
    modelSettings: { temperature: 0 },
    wireApi: "chat-completions",
    body,
  };
}

async function walkFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walkFiles(path)));
    else files.push(path);
  }
  return files;
}

async function findCallFileForRun(
  rootDirectory: string,
  runId: string,
): Promise<string> {
  const files = await walkFiles(join(rootDirectory, "calls"));
  for (const file of files) {
    const content = await readFile(file, "utf8");
    if (content.includes(`"runId":"${runId}"`)) return file;
  }
  throw new Error(`stored call for ${runId} not found`);
}

async function start(gateway: PersistentModelGateway, runId: string) {
  return await gateway.startRun({
    runId,
    expiresAtMs: 10_000,
    allowedModels: ["gpt-test"],
  });
}

describe("P0-04 review hardening", () => {
  it("lists only the requested run directory and never reads another run's call files", async () => {
    const { directory, store, gateway } = await createGateway();
    const runA = await start(gateway, "run-a");
    const runB = await start(gateway, "run-b");

    await gateway.call(runA.token, request("run-a", "call-a"));
    await gateway.call(runB.token, request("run-b", "call-b"));

    const runBFile = await findCallFileForRun(directory, "run-b");
    await writeFile(runBFile, "this file must never be read while listing run-a\n");

    await expect(store.listCostRecords("run-a")).resolves.toHaveLength(1);
  });

  it("rejects a reused idempotency key when the request changes", async () => {
    const { adapter, gateway } = await createGateway();
    const { token } = await start(gateway, "run-1");

    await gateway.call(token, request("run-1", "same-key"));

    await expect(
      gateway.call(
        token,
        request("run-1", "same-key", {
          messages: [{ role: "user", content: "Fix a different bug" }],
          max_tokens: 200,
        }),
      ),
    ).rejects.toThrow(/idempotency key .*different request/i);
    expect(adapter.calls).toHaveLength(1);
  });
});

describe("LiteLLM usage normalization", () => {
  async function normalize(
    wireApi: ModelCallRequest["wireApi"],
    usage: Readonly<Record<string, unknown>>,
  ) {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "response", usage }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-litellm-response-cost": "0.01",
        },
      }),
    );
    const adapter = new LiteLLMAdapter({
      baseUrl: "https://litellm.example.com",
      adminToken: "gateway-admin-secret",
      fetch: fetchMock,
      clock: () => 1_000,
    });

    return (
      await adapter.call({
        ...request("run-1", `usage-${wireApi}`),
        wireApi,
        credential: "run-scoped-key",
      })
    ).usage;
  }

  it("normalizes OpenAI chat-completions input and cache-read usage", async () => {
    await expect(
      normalize("chat-completions", {
        prompt_tokens: 100,
        completion_tokens: 40,
        prompt_tokens_details: { cached_tokens: 20 },
        completion_tokens_details: { reasoning_tokens: 5 },
      }),
    ).resolves.toEqual({
      inputTokens: 100,
      cachedInputTokens: 20,
      cacheWriteInputTokens: 0,
      outputTokens: 40,
      reasoningTokens: 5,
    });
  });

  it("normalizes OpenAI responses input and cache-read usage", async () => {
    await expect(
      normalize("responses", {
        input_tokens: 110,
        output_tokens: 50,
        input_tokens_details: { cached_tokens: 30 },
        output_tokens_details: { reasoning_tokens: 7 },
      }),
    ).resolves.toEqual({
      inputTokens: 110,
      cachedInputTokens: 30,
      cacheWriteInputTokens: 0,
      outputTokens: 50,
      reasoningTokens: 7,
    });
  });

  it("normalizes Anthropic messages so total input includes cache reads and writes", async () => {
    await expect(
      normalize("anthropic-messages", {
        input_tokens: 80,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 10,
        output_tokens: 30,
      }),
    ).resolves.toEqual({
      inputTokens: 110,
      cachedInputTokens: 20,
      cacheWriteInputTokens: 10,
      outputTokens: 30,
      reasoningTokens: 0,
    });
  });
});

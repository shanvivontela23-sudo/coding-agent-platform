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
} from "../src/gateway/http/index.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function request(token: string) {
  return {
    method: "POST",
    path: "/v1/responses",
    headers: { authorization: `Bearer ${token}` },
    body: (async function* () {
      yield Buffer.from(JSON.stringify({ model: "primary-model", input: "x" }));
    })(),
  } as const;
}

describe("paid harness spend concurrency", () => {
  it("does not let concurrent paid requests both pass the same pre-dispatch spend check", async () => {
    let releaseFirst!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted!: () => void;
    const firstWasStarted = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let callNumber = 0;
    const fetchMock = vi.fn(async () => {
      callNumber += 1;
      if (callNumber === 1) {
        firstStarted();
        await firstCanFinish;
      }
      return new Response(
        JSON.stringify({
          id: `resp-${callNumber}`,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-litellm-response-cost": "0.10",
          },
        },
      );
    });

    const root = await mkdtemp(join(tmpdir(), "coding-agent-http-spend-race-"));
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
      spendCapUsd: 0.1,
      upstreamCredential: "run-litellm-secret",
      allowedModels: ["primary-model"],
      status: "active",
    });
    const token = tokenService.issue("run-1", 10_000);
    const transport = new LiteLLMHarnessTransport({
      baseUrl: "https://litellm.example.com",
      fetch: fetchMock as typeof fetch,
      gatewayStore,
      callStore,
      nonStreamingTimeoutMs: 500,
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
      dispatch: (dispatchRequest) => transport.forward(dispatchRequest),
    });

    const first = handler(request(token));
    await firstWasStarted;
    const second = handler(request(token));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    releaseFirst();

    expect((await first).status).toBe(200);
    expect((await second).status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await gatewayStore.getRun("run-1")).status).toBe("limit-hit");
  });
});

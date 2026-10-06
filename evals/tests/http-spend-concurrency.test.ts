import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileGatewayStore, RunTokenService } from "../src/gateway/index.js";
import {
  FileHarnessCallStore,
  RunTokenBucket,
  createHarnessHttpHandler,
  loadHarnessHttpConfig,
  type HarnessCallRecord,
} from "../src/gateway/http/index.js";

const roots: string[] = [];

afterEach(async () => {
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
      yield Buffer.from(
        JSON.stringify({ model: "primary-model", input: "x", stream: true }),
      );
    })(),
  } as const;
}

function streamEnabledConfig() {
  const config = loadHarnessHttpConfig();
  return {
    ...config,
    routes: config.routes.map((route) =>
      route.path === "/v1/responses"
        ? { ...route, streamingAllowed: true }
        : route,
    ),
  };
}

async function setup(spendCapUsd = 0.1) {
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
    spendCapUsd,
    upstreamCredential: "run-litellm-secret",
    allowedModels: ["primary-model"],
    status: "active",
  });
  return {
    gatewayStore,
    callStore,
    tokenService,
    token: tokenService.issue("run-1", 10_000),
  };
}

describe("paid harness spend reservations", () => {
  it("releases the run lock before dispatch so two streams can overlap", async () => {
    const { gatewayStore, callStore, tokenService, token } = await setup();
    let firstEntered!: () => void;
    const firstWasEntered = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    let allowFirstToReturn!: () => void;
    const firstMayReturn = new Promise<void>((resolve) => {
      allowFirstToReturn = resolve;
    });
    let secondEntered!: () => void;
    const secondWasEntered = new Promise<void>((resolve) => {
      secondEntered = resolve;
    });
    let callNumber = 0;
    const streamControllers: ReadableStreamDefaultController<Uint8Array>[] = [];

    const dispatch = async () => {
      callNumber += 1;
      const thisCall = callNumber;
      if (thisCall === 1) {
        firstEntered();
        await firstMayReturn;
      } else if (thisCall === 2) {
        secondEntered();
      }
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          streamControllers.push(controller);
        },
      });
      return {
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body,
        settlement: Promise.resolve({ costUsd: 0.04 }),
      };
    };

    const handler = createHarnessHttpHandler({
      config: streamEnabledConfig(),
      tokenService,
      gatewayStore,
      callStore,
      rateLimiter: new RunTokenBucket({
        ratePerMinute: 120,
        burst: 20,
        clock: () => 1_000,
      }),
      clock: () => 1_000,
      estimateCostUsd: async () => 0.04,
      reconcilePendingCall: async () => undefined,
      dispatch,
    });

    const first = handler(request(token));
    await firstWasEntered;
    const second = handler(request(token));

    await secondWasEntered;
    expect(callNumber).toBe(2);
    allowFirstToReturn();
    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(firstResponse.body).toBeInstanceOf(ReadableStream);
    expect(secondResponse.body).toBeInstanceOf(ReadableStream);
    expect(streamControllers).toHaveLength(2);

    for (const controller of streamControllers) controller.close();
  });

  it("counts outstanding reservations so concurrent estimates cannot overbook the run cap", async () => {
    const { gatewayStore, callStore, tokenService, token } = await setup();
    const settlements: Array<(value: { costUsd: number }) => void> = [];
    let dispatched = 0;
    const handler = createHarnessHttpHandler({
      config: streamEnabledConfig(),
      tokenService,
      gatewayStore,
      callStore,
      rateLimiter: new RunTokenBucket({
        ratePerMinute: 120,
        burst: 20,
        clock: () => 1_000,
      }),
      clock: () => 1_000,
      estimateCostUsd: async () => 0.04,
      reconcilePendingCall: async () => undefined,
      dispatch: async () => {
        dispatched += 1;
        let settle!: (value: { costUsd: number }) => void;
        const settlement = new Promise<{ costUsd: number }>((resolve) => {
          settle = resolve;
        });
        settlements.push(settle);
        return {
          status: 200,
          headers: { "content-type": "text/event-stream" },
          body: new ReadableStream<Uint8Array>(),
          settlement,
        };
      },
    });

    expect((await handler(request(token))).status).toBe(200);
    expect((await handler(request(token))).status).toBe(200);
    const third = await handler(request(token));

    expect(dispatched).toBe(2);
    expect(third.status).toBe(429);
    expect((await gatewayStore.getRun("run-1")).status).toBe("active");

    for (const settle of settlements) settle({ costUsd: 0.04 });
    await Promise.resolve();
  });

  it("reconciles a persisted pending cost inline instead of waiting for finishRun", async () => {
    const { gatewayStore, callStore, tokenService, token } = await setup(1);
    const pending: HarnessCallRecord = {
      runId: "run-1",
      callId: "prior-call",
      method: "POST",
      path: "/v1/responses",
      wireApi: "responses",
      provider: "openai",
      model: "primary-model",
      modelSettings: {},
      paid: true,
      state: "completed",
      usage: {
        inputTokens: 1,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 1,
        reasoningTokens: 0,
      },
      latencyMs: 10,
      litellmCallId: "prior-call",
      listPriceCostUsd: null,
      costPending: true,
      createdAtMs: 900,
      updatedAtMs: 900,
    };
    await callStore.createCall(pending);
    let reconciliations = 0;
    let dispatched = 0;

    const handler = createHarnessHttpHandler({
      config: streamEnabledConfig(),
      tokenService,
      gatewayStore,
      callStore,
      rateLimiter: new RunTokenBucket({
        ratePerMinute: 120,
        burst: 20,
        clock: () => 1_000,
      }),
      clock: () => 1_000,
      estimateCostUsd: async () => 0.1,
      reconcilePendingCall: async (_run, callId) => {
        reconciliations += 1;
        const record = await callStore.getCall("run-1", callId);
        await callStore.saveCall({
          ...record,
          listPriceCostUsd: 0.2,
          costPending: false,
          updatedAtMs: 1_000,
        });
      },
      dispatch: async () => {
        dispatched += 1;
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: Buffer.from("{}"),
          settlement: Promise.resolve({ costUsd: 0.1 }),
        };
      },
    });

    const response = await handler(request(token));
    expect(response.status).toBe(200);
    expect(reconciliations).toBe(1);
    expect(dispatched).toBe(1);
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileGatewayStore,
  PersistentModelGateway,
  RunTokenService,
  type ModelProviderAdapter,
  type ProviderCallResponse,
  type ProviderRunStartRequest,
} from "../src/gateway/index.js";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

class MockAdapter implements ModelProviderAdapter {
  async startRun(request: ProviderRunStartRequest) {
    return { credential: `credential-${request.runId}` };
  }

  async estimateMaxCostUsd() {
    return 0;
  }

  async call(): Promise<ProviderCallResponse> {
    return {
      body: { id: "response" },
      usage: {
        inputTokens: 1,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 1,
        reasoningTokens: 0,
      },
      latencyMs: 1,
      listPriceCostUsd: 0.01,
    };
  }
}

async function createGateway() {
  const directory = await mkdtemp(join(tmpdir(), "coding-agent-http-run-"));
  tempDirectories.push(directory);
  const store = new FileGatewayStore({ rootDir: directory });
  const tokenService = new RunTokenService({
    secret: "test-secret-that-is-long-enough-for-hmac",
    clock: () => 1_000,
  });
  const gateway = new PersistentModelGateway({
    store,
    adapter: new MockAdapter(),
    tokenService,
    clock: () => 1_000,
  });
  return { gateway, store, tokenService };
}

describe("P0-05 HTTP run contract", () => {
  it("verifies signed claims without trusting a caller-supplied run id", () => {
    const tokenService = new RunTokenService({
      secret: "test-secret-that-is-long-enough-for-hmac",
      clock: () => 1_000,
    });
    const token = tokenService.issue("run-from-token", 10_000);

    expect(
      (tokenService as RunTokenService & {
        verifyClaims(token: string): { runId: string; expiresAtMs: number };
      }).verifyClaims(token),
    ).toMatchObject({ runId: "run-from-token", expiresAtMs: 10_000 });
  });

  it("persists an exact primary and background model allowlist per run", async () => {
    const { gateway, store } = await createGateway();

    await (gateway.startRun as unknown as (request: unknown) => Promise<unknown>)({
      runId: "run-a",
      expiresAtMs: 10_000,
      allowedModels: ["primary-model", "background-model"],
    });
    await (gateway.startRun as unknown as (request: unknown) => Promise<unknown>)({
      runId: "run-b",
      expiresAtMs: 10_000,
      allowedModels: ["other-model"],
    });

    expect(await store.getRun("run-a")).toMatchObject({
      allowedModels: ["primary-model", "background-model"],
    });
    expect(await store.getRun("run-b")).toMatchObject({
      allowedModels: ["other-model"],
    });
  });

  it("rejects empty, blank, or duplicate model allowlists", async () => {
    const { gateway } = await createGateway();
    const start = gateway.startRun as unknown as (request: unknown) => Promise<unknown>;

    await expect(
      start({ runId: "empty", expiresAtMs: 10_000, allowedModels: [] }),
    ).rejects.toThrow(/allowedModels/i);
    await expect(
      start({ runId: "blank", expiresAtMs: 10_000, allowedModels: ["   "] }),
    ).rejects.toThrow(/allowedModels/i);
    await expect(
      start({
        runId: "duplicate",
        expiresAtMs: 10_000,
        allowedModels: ["model-a", " model-a "],
      }),
    ).rejects.toThrow(/allowedModels/i);
  });
});

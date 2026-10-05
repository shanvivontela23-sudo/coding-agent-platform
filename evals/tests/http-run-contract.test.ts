import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileGatewayStore,
  PersistentModelGateway,
  RunTokenService,
  type GatewayRunRecord,
  type ModelProviderAdapter,
  type ProviderCallResponse,
  type ProviderRunCredential,
  type ProviderRunStartRequest,
  type RunTokenClaims,
  type StartRunRequest,
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
  async startRun(
    request: ProviderRunStartRequest,
  ): Promise<ProviderRunCredential> {
    return { credential: `credential-${request.runId}` };
  }

  async estimateMaxCostUsd(): Promise<number | null> {
    return 0;
  }

  async call(): Promise<ProviderCallResponse> {
    throw new Error("not used by run contract tests");
  }
}

async function createGateway(clock = () => 1_000) {
  const directory = await mkdtemp(join(tmpdir(), "coding-agent-http-run-"));
  tempDirectories.push(directory);
  const store = new FileGatewayStore({ rootDir: directory });
  const tokenService = new RunTokenService({
    secret: "test-secret-that-is-long-enough-for-hmac",
    clock,
  });
  const gateway = new PersistentModelGateway({
    store,
    adapter: new MockAdapter(),
    tokenService,
    clock,
  });
  return { gateway, store, tokenService };
}

describe("P0-05 run contract", () => {
  it("verifies signed claims without trusting a caller-supplied run id", () => {
    const tokenService = new RunTokenService({
      secret: "test-secret-that-is-long-enough-for-hmac",
      clock: () => 1_000,
    });
    const token = tokenService.issue("run-a", 2_000);
    const claims = (
      tokenService as unknown as {
        verifyClaims(value: string): RunTokenClaims;
      }
    ).verifyClaims(token);

    expect(claims).toEqual({
      version: 1,
      runId: "run-a",
      expiresAtMs: 2_000,
    });
    expect(() => tokenService.verify(token, "run-b")).toThrow(
      "run token is not valid for run-b",
    );
  });

  it("rejects tampered and expired tokens through claim-only verification", () => {
    let now = 1_000;
    const tokenService = new RunTokenService({
      secret: "test-secret-that-is-long-enough-for-hmac",
      clock: () => now,
    });
    const verifyClaims = (
      tokenService as unknown as {
        verifyClaims(value: string): RunTokenClaims;
      }
    ).verifyClaims.bind(tokenService);
    const token = tokenService.issue("run-a", 2_000);

    expect(() => verifyClaims(`${token}x`)).toThrow("run token is invalid");
    now = 2_000;
    expect(() => verifyClaims(token)).toThrow("run token has expired");
  });

  it("persists an exact per-run model allowlist including background models", async () => {
    const { gateway, store } = await createGateway();
    const firstRequest = {
      runId: "run-a",
      expiresAtMs: 10_000,
      allowedModels: ["primary-model", "background-model"],
    } as StartRunRequest & { allowedModels: readonly string[] };
    const secondRequest = {
      runId: "run-b",
      expiresAtMs: 10_000,
      allowedModels: ["other-model"],
    } as StartRunRequest & { allowedModels: readonly string[] };

    await gateway.startRun(firstRequest);
    await gateway.startRun(secondRequest);

    const first = (await store.getRun("run-a")) as GatewayRunRecord & {
      allowedModels?: readonly string[];
    };
    const second = (await store.getRun("run-b")) as GatewayRunRecord & {
      allowedModels?: readonly string[];
    };

    expect(first.allowedModels).toEqual(["primary-model", "background-model"]);
    expect(second.allowedModels).toEqual(["other-model"]);
  });

  it("rejects empty, blank, or duplicate model allowlists", async () => {
    const cases = [
      [],
      [""],
      ["primary-model", " primary-model "],
    ] as const;

    for (const [index, allowedModels] of cases.entries()) {
      const { gateway } = await createGateway();
      const request = {
        runId: `run-${index}`,
        expiresAtMs: 10_000,
        allowedModels,
      } as StartRunRequest & { allowedModels: readonly string[] };

      await expect(gateway.startRun(request)).rejects.toThrow(/allowedModels/i);
    }
  });
});

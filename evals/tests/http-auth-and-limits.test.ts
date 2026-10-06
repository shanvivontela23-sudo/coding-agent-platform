import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileGatewayStore, RunTokenService } from "../src/gateway/index.js";
import {
  FileHarnessCallStore,
  RunTokenBucket,
  createHarnessHttpHandler,
  loadHarnessHttpConfig,
  type HarnessInboundRequest,
} from "../src/gateway/http/index.js";

const tempDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function jsonBody(value: unknown, tracker?: { chunks: number }) {
  const bytes = Buffer.from(JSON.stringify(value));
  return (async function* () {
    if (tracker) tracker.chunks += 1;
    yield bytes;
  })();
}

function request(
  headers: Readonly<Record<string, string>>,
  body: AsyncIterable<Uint8Array>,
  path = "/v1/responses",
): HarnessInboundRequest {
  return { method: "POST", path, headers, body };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "coding-agent-http-auth-"));
  tempDirectories.push(root);
  const gatewayStore = new FileGatewayStore({ rootDir: join(root, "gateway") });
  const callStore = new FileHarnessCallStore({ rootDir: join(root, "http") });
  let now = 1_000;
  const clock = () => now;
  const tokenService = new RunTokenService({
    secret: "test-secret-that-is-long-enough-for-hmac",
    clock,
  });
  await gatewayStore.createRun({
    runId: "run-1",
    expiresAtMs: 10_000,
    spendCapUsd: 10,
    upstreamCredential: "hidden-litellm-key",
    allowedModels: ["primary-model", "background-model"],
    status: "active",
  });
  const token = tokenService.issue("run-1", 10_000);
  const dispatch = vi.fn(async () => ({
    status: 200,
    headers: { "content-type": "application/json" },
    body: Buffer.from('{"ok":true}'),
    settlement: Promise.resolve({ costUsd: 0.01 }),
  }));
  const handler = createHarnessHttpHandler({
    config: loadHarnessHttpConfig(),
    tokenService,
    gatewayStore,
    callStore,
    rateLimiter: new RunTokenBucket({ ratePerMinute: 120, burst: 20, clock }),
    clock,
    estimateCostUsd: async () => 0.01,
    reconcilePendingCall: async () => undefined,
    dispatch,
  });
  return {
    callStore,
    dispatch,
    gatewayStore,
    handler,
    token,
    setNow: (value: number) => {
      now = value;
    },
  };
}

describe("harness HTTP auth and limits", () => {
  it("accepts bearer, x-api-key, and matching dual auth", async () => {
    const { handler, token } = await fixture();
    for (const headers of [
      { authorization: `Bearer ${token}` },
      { "x-api-key": token },
      { authorization: `Bearer ${token}`, "x-api-key": token },
    ]) {
      const response = await handler(
        request(headers, jsonBody({ model: "primary-model", input: "x" })),
      );
      expect(response.status).toBe(200);
    }
  });

  it("rejects missing or conflicting auth before reading the body", async () => {
    const { handler, token } = await fixture();
    for (const headers of [
      {},
      { authorization: `Bearer ${token}`, "x-api-key": "different-token" },
    ]) {
      const tracker = { chunks: 0 };
      const response = await handler(
        request(headers, jsonBody({ model: "primary-model" }, tracker)),
      );
      expect(response.status).toBe(401);
      expect(tracker.chunks).toBe(0);
    }
  });

  it("rejects oversized authenticated bodies before consuming the full stream", async () => {
    const { handler, token } = await fixture();
    let chunks = 0;
    const body = (async function* () {
      for (let index = 0; index < 20; index += 1) {
        chunks += 1;
        yield new Uint8Array(1024 * 1024);
      }
    })();
    const response = await handler(
      request({ authorization: `Bearer ${token}` }, body),
    );
    expect(response.status).toBe(413);
    expect(chunks).toBeLessThan(20);
  });

  it("enforces the per-token burst and refill rate", async () => {
    const { handler, token, setNow } = await fixture();
    const call = () =>
      handler(
        request(
          { authorization: `Bearer ${token}` },
          jsonBody({ model: "primary-model", input: "x" }),
        ),
      );

    for (let index = 0; index < 20; index += 1) {
      expect((await call()).status).toBe(200);
    }
    expect((await call()).status).toBe(429);
    setNow(1_500);
    expect((await call()).status).toBe(200);
  });

  it("allows exact primary/background models and refuses aliases or another model", async () => {
    const { callStore, dispatch, handler, token } = await fixture();
    for (const model of ["primary-model", "background-model"]) {
      expect(
        (
          await handler(
            request({ "x-api-key": token }, jsonBody({ model, input: "x" })),
          )
        ).status,
      ).toBe(200);
    }
    for (const model of ["Primary-model", "primary-model-latest", "other-model"]) {
      expect(
        (
          await handler(
            request({ "x-api-key": token }, jsonBody({ model, input: "x" })),
          )
        ).status,
      ).toBe(400);
    }
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(await callStore.listRefusals("run-1")).toHaveLength(3);
  });

  it("refuses unknown/disabled routes but allows approved streaming routes", async () => {
    const { callStore, dispatch, handler, token } = await fixture();
    const headers = { authorization: `Bearer ${token}` };

    expect(
      (
        await handler(
          request(headers, jsonBody({ model: "primary-model" }), "/v1/unknown"),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await handler(
          request(
            headers,
            jsonBody({ model: "primary-model" }),
            "/v1/chat/completions",
          ),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await handler(
          request(headers, jsonBody({ model: "primary-model", stream: true })),
        )
      ).status,
    ).toBe(200);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(await callStore.listRefusals("run-1")).toHaveLength(2);
  });
});

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
  type HarnessDispatchRequest,
} from "../src/gateway/http/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function body(value: unknown) {
  return (async function* () {
    yield Buffer.from(JSON.stringify(value));
  })();
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "coding-agent-pr-a-hardening-"));
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
    upstreamCredential: "hidden-run-key",
    allowedModels: ["primary-model"],
    status: "active",
  });
  const token = tokenService.issue("run-1", 10_000);
  const dispatch = vi.fn(async (request: HarnessDispatchRequest) => {
    void request;
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: Buffer.from("{}"),
    };
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
    dispatch,
  });
  return { dispatch, handler, token };
}

describe("P0-05A security hardening", () => {
  it.each([true, "true", 1])(
    "refuses every non-false stream request in PR A: %j",
    async (stream) => {
      const { dispatch, handler, token } = await setup();
      const response = await handler({
        method: "POST",
        path: "/v1/responses",
        headers: { authorization: `Bearer ${token}` },
        body: body({ model: "primary-model", input: "x", stream }),
      });
      expect(response.status).toBe(400);
      expect(dispatch).not.toHaveBeenCalled();
    },
  );

  it("keeps arbitrary nested request data out of persisted-safe model settings", async () => {
    const { dispatch, handler, token } = await setup();
    const marker = "DO-NOT-PERSIST-secret-marker";
    const response = await handler({
      method: "POST",
      path: "/v1/responses",
      headers: { authorization: `Bearer ${token}` },
      body: body({
        model: "primary-model",
        input: "x",
        temperature: { secret: marker },
        reasoning: { effort: "high", secret: marker },
      }),
    });

    expect(response.status).toBe(200);
    const dispatched = dispatch.mock.calls[0]?.[0];
    expect(dispatched?.modelSettings).toEqual({ reasoning: { effort: "high" } });
    expect(JSON.stringify(dispatched?.modelSettings)).not.toContain(marker);
  });

  it("does not forward harness-controlled OpenAI account-selection headers by default", () => {
    const config = loadHarnessHttpConfig();
    const route = config.routes.find((entry) => entry.path === "/v1/responses");
    expect(route?.forwardRequestHeaders).toEqual(["content-type"]);
  });
});

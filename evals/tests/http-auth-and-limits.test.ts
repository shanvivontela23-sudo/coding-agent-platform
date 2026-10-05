import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FileGatewayStore,
  RunTokenService,
  type GatewayRunRecord,
} from "../src/gateway/index.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function modules() {
  const authPath = "../src/gateway/http/auth.js";
  const ratePath = "../src/gateway/http/rate-limiter.js";
  const handlerPath = "../src/gateway/http/handler.js";
  const configPath = "../src/gateway/http/config.js";
  const storePath = "../src/gateway/http/file-store.js";
  const [auth, rate, handler, config, store] = await Promise.all([
    import(authPath).catch(() => ({} as Record<string, unknown>)),
    import(ratePath).catch(() => ({} as Record<string, unknown>)),
    import(handlerPath).catch(() => ({} as Record<string, unknown>)),
    import(configPath).catch(() => ({} as Record<string, unknown>)),
    import(storePath).catch(() => ({} as Record<string, unknown>)),
  ]);
  return { auth, rate, handler, config, store };
}

function tokenService(clock = () => 1_000) {
  return new RunTokenService({
    secret: "test-secret-that-is-long-enough-for-hmac",
    clock,
  });
}

async function createStores(run: GatewayRunRecord) {
  const root = await mkdtemp(join(tmpdir(), "http-guard-store-"));
  roots.push(root);
  const gatewayStore = new FileGatewayStore({ rootDir: join(root, "gateway") });
  await gatewayStore.createRun(run);
  const { store } = await modules();
  expect(typeof store.FileHarnessCallStore).toBe("function");
  const Store = store.FileHarnessCallStore as new (options: { rootDir: string }) => {
    listRefusals(runId: string): Promise<Array<{ reason: string }>>;
    appendRefusal(value: unknown): Promise<void>;
  };
  return { gatewayStore, callStore: new Store({ rootDir: join(root, "http") }) };
}

function activeRun(runId = "run-a"): GatewayRunRecord {
  return {
    runId,
    expiresAtMs: 10_000,
    spendCapUsd: 10,
    upstreamCredential: "upstream-secret-must-not-leak",
    allowedModels: ["primary-model", "background-model"],
    status: "active",
  };
}

function jsonRequest(path: string, token: string, body: Record<string, unknown>) {
  return new Request(`https://gateway.example.com${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("P0-05 public HTTP guards", () => {
  it("accepts bearer or x-api-key and rejects conflicting dual credentials", async () => {
    const { auth } = await modules();
    expect(typeof auth.authenticateHarnessRequest).toBe("function");
    const service = tokenService();
    const token = service.issue("run-a", 10_000);
    const authenticate = auth.authenticateHarnessRequest as (
      headers: Headers,
      service: RunTokenService,
    ) => { token: string; claims: { runId: string } };

    expect(authenticate(new Headers({ authorization: `Bearer ${token}` }), service).claims.runId).toBe("run-a");
    expect(authenticate(new Headers({ "x-api-key": token }), service).claims.runId).toBe("run-a");
    expect(
      authenticate(
        new Headers({ authorization: `Bearer ${token}`, "x-api-key": token }),
        service,
      ).token,
    ).toBe(token);
    expect(() =>
      authenticate(
        new Headers({ authorization: `Bearer ${token}`, "x-api-key": `${token}x` }),
        service,
      ),
    ).toThrow(/conflicting/i);
  });

  it("rejects unauthenticated input before reading the body", async () => {
    const { handler, config } = await modules();
    expect(typeof handler.createHarnessHttpHandler).toBe("function");
    const service = tokenService();
    const { gatewayStore, callStore } = await createStores(activeRun());
    const gatewayConfig = await (config.loadHarnessHttpConfig as () => Promise<unknown>)();
    const dispatch = vi.fn();
    const handle = (handler.createHarnessHttpHandler as (options: unknown) => (request: Request) => Promise<Response>)({
      tokenService: service,
      gatewayStore,
      callStore,
      config: gatewayConfig,
      dispatch,
      clock: () => 1_000,
    });

    const request = new Request("https://gateway.example.com/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "primary-model", payload: "must-not-be-read" }),
    });
    expect(request.bodyUsed).toBe(false);
    const response = await handle(request);

    expect(response.status).toBe(401);
    expect(request.bodyUsed).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("enforces the burst and refill rate per token digest", async () => {
    const { rate } = await modules();
    expect(typeof rate.RunTokenBucket).toBe("function");
    let now = 0;
    const Bucket = rate.RunTokenBucket as new (options: {
      ratePerMinute: number;
      burst: number;
      clock: () => number;
    }) => { consume(token: string): boolean };
    const bucket = new Bucket({ ratePerMinute: 120, burst: 20, clock: () => now });

    for (let i = 0; i < 20; i += 1) expect(bucket.consume("secret-run-token")).toBe(true);
    expect(bucket.consume("secret-run-token")).toBe(false);
    now = 500;
    expect(bucket.consume("secret-run-token")).toBe(true);
    expect(JSON.stringify(bucket)).not.toContain("secret-run-token");
  });

  it("refuses unknown routes, disallowed models, and all streaming before dispatch", async () => {
    const { handler, config } = await modules();
    expect(typeof handler.createHarnessHttpHandler).toBe("function");
    const service = tokenService();
    const token = service.issue("run-a", 10_000);
    const { gatewayStore, callStore } = await createStores(activeRun());
    const gatewayConfig = await (config.loadHarnessHttpConfig as () => Promise<unknown>)();
    const dispatch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const handle = (handler.createHarnessHttpHandler as (options: unknown) => (request: Request) => Promise<Response>)({
      tokenService: service,
      gatewayStore,
      callStore,
      config: gatewayConfig,
      dispatch,
      clock: () => 1_000,
    });

    expect((await handle(jsonRequest("/v1/unknown", token, { model: "primary-model" }))).status).toBe(404);
    expect((await handle(jsonRequest("/v1/responses", token, { model: "Primary-Model" }))).status).toBe(400);
    expect((await handle(jsonRequest("/v1/responses", token, { model: "primary-model", stream: true }))).status).toBe(501);
    expect((await handle(jsonRequest("/v1/chat/completions", token, { model: "primary-model" }))).status).toBe(404);
    expect(dispatch).not.toHaveBeenCalled();

    const refusals = await callStore.listRefusals("run-a");
    expect(refusals.map((record) => record.reason).sort()).toEqual([
      "model-not-allowed",
      "route-disabled",
      "streaming-not-implemented",
      "unknown-route",
    ]);
  });

  it("accepts exact primary and background models", async () => {
    const { handler, config } = await modules();
    const service = tokenService();
    const token = service.issue("run-a", 10_000);
    const { gatewayStore, callStore } = await createStores(activeRun());
    const gatewayConfig = await (config.loadHarnessHttpConfig as () => Promise<unknown>)();
    const dispatch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const handle = (handler.createHarnessHttpHandler as (options: unknown) => (request: Request) => Promise<Response>)({
      tokenService: service,
      gatewayStore,
      callStore,
      config: gatewayConfig,
      dispatch,
      clock: () => 1_000,
    });

    expect((await handle(jsonRequest("/v1/responses", token, { model: "primary-model" }))).status).toBe(200);
    expect((await handle(jsonRequest("/v1/responses", token, { model: "background-model" }))).status).toBe(200);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
});

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  createListPriceCostEstimator,
  loadGatewayServerConfig,
  type HarnessDispatchRequest,
} from "../src/gateway/http/index.js";

function dispatchRequest(body: Readonly<Record<string, unknown>>): HarnessDispatchRequest {
  return {
    run: {
      runId: "run-1",
      expiresAtMs: 10_000,
      spendCapUsd: 10,
      upstreamCredential: "synthetic-upstream-key",
      allowedModels: ["primary-model"],
      status: "active",
    },
    route: {
      method: "POST",
      path: "/v1/responses",
      wireApi: "responses",
      enabled: true,
      streamingAllowed: true,
      paid: true,
      modelField: "model",
      forwardRequestHeaders: [],
      safeResponseHeaders: [],
      modelSettingFields: ["max_output_tokens"],
    },
    requestHeaders: {},
    body,
    callId: "call-1",
    provider: "openai",
    model: "primary-model",
    modelSettings: { max_output_tokens: body.max_output_tokens },
  };
}

const validEnv = {
  MODEL_GATEWAY_RUN_TOKEN_SECRET: "synthetic-signing-secret-that-is-long-enough",
  LITELLM_GATEWAY_URL: "http://localhost:4000",
  LITELLM_ADMIN_TOKEN: "synthetic-admin-token",
  GATEWAY_STORE_DIR: "/data/gateway",
  HARNESS_CALL_STORE_DIR: "/data/http",
  HARNESS_MODEL_PRICES_JSON: JSON.stringify({
    "primary-model": {
      inputUsdPerMillionTokens: 5,
      outputUsdPerMillionTokens: 15,
      defaultMaxOutputTokens: 1_000,
    },
  }),
} as const;

describe("gateway server composition", () => {
  it("fails closed when required signing, LiteLLM, store, or pricing settings are missing", () => {
    for (const key of Object.keys(validEnv)) {
      const env = { ...validEnv } as Record<string, string | undefined>;
      delete env[key];
      expect(() => loadGatewayServerConfig(env)).toThrow(key);
    }
  });

  it("reserves input-size plus requested output-limit cost at configured list price", async () => {
    const config = loadGatewayServerConfig(validEnv);
    const estimator = createListPriceCostEstimator(config.modelPrices);
    const body = {
      model: "primary-model",
      input: "hello world",
      max_output_tokens: 200,
    } as const;
    const inputBytes = Buffer.byteLength(JSON.stringify(body), "utf8");

    await expect(estimator(dispatchRequest(body))).resolves.toBeCloseTo(
      (inputBytes * 5 + 200 * 15) / 1_000_000,
      12,
    );
  });

  it("fails reservation when a paid model has no configured list price", async () => {
    const estimator = createListPriceCostEstimator({});
    await expect(
      estimator(dispatchRequest({ model: "primary-model", input: "x", max_output_tokens: 10 })),
    ).rejects.toThrow("primary-model");
  });
});

describe("committed deployment contract", () => {
  it("uses the intended Caddy -> gateway -> LiteLLM/Postgres topology and immutable external images", async () => {
    const compose = await readFile("evals/deploy/http-gateway/compose.yaml", "utf8");
    expect(compose).toContain("caddy:");
    expect(compose).toContain("gateway:");
    expect(compose).toContain("litellm:");
    expect(compose).toContain("postgres:");
    expect(compose).toContain("HTTP_GATEWAY_PORT: 8080");
    expect(compose).toContain("litellm:4000");
    expect(compose).not.toContain(":latest");
    for (const line of compose.split("\n").filter((line) => line.trim().startsWith("image:"))) {
      expect(line).toMatch(/@sha256:[0-9a-f]{64}\s*$/);
    }
  });

  it("does not inject provider, E2B, or database secrets into the Node gateway", async () => {
    const compose = await readFile("evals/deploy/http-gateway/compose.yaml", "utf8");
    const gatewayBlock = compose.match(/\n  gateway:\n([\s\S]*?)(?=\n  litellm:)/)?.[1];
    expect(gatewayBlock).toBeDefined();
    expect(gatewayBlock).not.toContain("env_file:");
    expect(gatewayBlock).toContain("MODEL_GATEWAY_RUN_TOKEN_SECRET: ${MODEL_GATEWAY_RUN_TOKEN_SECRET}");
    expect(gatewayBlock).toContain("LITELLM_ADMIN_TOKEN: ${LITELLM_ADMIN_TOKEN}");
    expect(gatewayBlock).toContain("HARNESS_MODEL_PRICES_JSON: ${HARNESS_MODEL_PRICES_JSON}");
    expect(gatewayBlock).not.toMatch(/OPENAI_API_KEY|ANTHROPIC_API_KEY|E2B_API_KEY|POSTGRES_PASSWORD/);
  });

  it("builds LiteLLM from the committed hash lock with a real require-hashes install", async () => {
    const dockerfile = await readFile("evals/deploy/http-gateway/Dockerfile.litellm", "utf8");
    expect(dockerfile).toContain("@sha256:");
    expect(dockerfile).toContain(
      "python -m pip install --require-hashes -r /app/evals/litellm/requirements.txt",
    );
    expect(dockerfile).not.toContain("--dry-run");
  });

  it("keeps Caddy unbuffered for SSE and exposes no unauthenticated public health route", async () => {
    const [caddyfile, serverSource] = await Promise.all([
      readFile("evals/deploy/http-gateway/Caddyfile", "utf8"),
      readFile("evals/src/gateway/http/server.ts", "utf8"),
    ]);
    expect(caddyfile).toContain("reverse_proxy gateway:8080");
    expect(caddyfile).not.toMatch(/buffer|response_buffers|request_buffers/i);
    expect(serverSource).not.toContain('"/health"');
    expect(serverSource).not.toContain("'/health'");
  });

  it("keeps every committed env example value empty", async () => {
    const example = await readFile(".env.example", "utf8");
    const assignments = example
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    expect(assignments.length).toBeGreaterThan(0);
    for (const assignment of assignments) expect(assignment).toMatch(/^[A-Z0-9_]+=$/);
  });
});

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  createListPriceCostEstimator,
  type HarnessDispatchRequest,
} from "../src/gateway/http/index.js";

function dispatchRequest(body: Readonly<Record<string, unknown>>): HarnessDispatchRequest {
  return {
    run: {
      runId: "run-review",
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
    callId: "call-review",
    provider: "openai",
    model: "primary-model",
    modelSettings: { max_output_tokens: body.max_output_tokens },
  };
}

describe("P0-06 review carry-overs", () => {
  it("estimates input tokens as ceil(UTF-8 bytes / 3)", async () => {
    const estimator = createListPriceCostEstimator({
      "primary-model": {
        inputUsdPerMillionTokens: 6,
        outputUsdPerMillionTokens: 18,
        defaultMaxOutputTokens: 1_000,
      },
    });
    const body = {
      model: "primary-model",
      input: "hello world — UTF-8",
      max_output_tokens: 200,
    } as const;
    const bytes = Buffer.byteLength(JSON.stringify(body), "utf8");
    const inputTokens = Math.ceil(bytes / 3);

    await expect(estimator(dispatchRequest(body))).resolves.toBeCloseTo(
      (inputTokens * 6 + 200 * 18) / 1_000_000,
      12,
    );
  });

  it("keeps the live reservation smoke math identical to the server estimator", async () => {
    const smoke = await readFile("evals/smoke/http-gateway-smoke.ts", "utf8");
    expect(smoke).toContain("Math.ceil(inputBytes / 3)");
  });

  it("forces Caddy to flush streaming responses immediately", async () => {
    const caddy = await readFile("evals/deploy/http-gateway/Caddyfile", "utf8");
    expect(caddy).toContain("flush_interval -1");
  });

  it("keeps the deployment README cloud-provider-neutral", async () => {
    const readme = await readFile("evals/deploy/http-gateway/README.md", "utf8");
    expect(readme).toContain("cloud-provider-neutral");
    expect(readme).not.toMatch(/DigitalOcean/i);
  });
});

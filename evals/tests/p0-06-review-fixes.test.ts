import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  createListPriceCostEstimator,
  type HarnessDispatchRequest,
} from "../src/gateway/http/index.js";

function dispatchWithBody(body: Readonly<Record<string, unknown>>): HarnessDispatchRequest {
  return {
    run: {
      runId: "review-fix-run",
      expiresAtMs: Date.now() + 60_000,
      spendCapUsd: 10,
      upstreamCredential: "not-a-real-key",
      allowedModels: ["review-model"],
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
      modelSettingFields: [],
    },
    requestHeaders: {},
    body,
    callId: "review-call",
    provider: "openai",
    model: "review-model",
    modelSettings: {},
  };
}

describe("P0-06 review fixes", () => {
  it("estimates conservative input tokens as ceil(UTF-8 bytes / 3)", async () => {
    const estimator = createListPriceCostEstimator({
      "review-model": {
        inputUsdPerMillionTokens: 3,
        outputUsdPerMillionTokens: 0,
        defaultMaxOutputTokens: 1,
      },
    });
    const request = dispatchWithBody({ model: "review-model", input: "ééabc" });
    const bytes = Buffer.byteLength(JSON.stringify(request.body), "utf8");
    const expected = (Math.ceil(bytes / 3) * 3) / 1_000_000;

    await expect(estimator(request)).resolves.toBe(expected);
  });

  it("disables Caddy response buffering for incremental harness streams", async () => {
    const caddy = await readFile("evals/deploy/http-gateway/Caddyfile", "utf8");
    expect(caddy).toContain("flush_interval -1");
  });

  it("keeps the deployment README host-neutral", async () => {
    const readme = await readFile("evals/deploy/http-gateway/README.md", "utf8");
    expect(readme).not.toMatch(/DigitalOcean/i);
    expect(readme).toMatch(/existing|operator-provided|host/i);
  });
});

import { describe, expect, it } from "vitest";
import {
  getHarnessRoute,
  loadHarnessHttpConfig,
} from "../src/gateway/http/index.js";

describe("harness HTTP route registry", () => {
  it("pins the approved Phase 0 limits and route defaults", () => {
    const config = loadHarnessHttpConfig();

    expect(config.limits).toEqual({
      maxBodyBytes: 8 * 1024 * 1024,
      ratePerMinute: 120,
      rateBurst: 20,
      nonStreamingTimeoutMs: 600_000,
      firstResponseTimeoutMs: 120_000,
      streamIdleTimeoutMs: 90_000,
      maxStreamDurationMs: 1_200_000,
      reconciliationTimeoutMs: 30_000,
      reconciliationInitialDelayMs: 500,
      reconciliationMaxDelayMs: 2_000,
      costToleranceUsd: 0.000001,
    });

    expect(getHarnessRoute("POST", "/v1/messages", config)?.enabled).toBe(true);
    expect(
      getHarnessRoute("POST", "/v1/messages/count_tokens", config)?.enabled,
    ).toBe(true);
    expect(getHarnessRoute("POST", "/v1/responses", config)?.enabled).toBe(true);
    expect(
      getHarnessRoute("POST", "/v1/chat/completions", config),
    ).toMatchObject({ enabled: false, wireApi: "chat-completions" });
    expect(getHarnessRoute("GET", "/v1/responses", config)).toBeNull();
    expect(getHarnessRoute("POST", "/v1/unknown", config)).toBeNull();
  });

  it("requires transcript evidence before chat completions can be enabled", () => {
    const base = loadHarnessHttpConfig();
    const unsafe = {
      ...base,
      routes: base.routes.map((route) =>
        route.path === "/v1/chat/completions"
          ? { ...route, enabled: true }
          : route,
      ),
      routeEvidence: {},
    };

    expect(() => loadHarnessHttpConfig(unsafe)).toThrow(
      /chat completions.*transcript/i,
    );

    const safe = {
      ...unsafe,
      routeEvidence: {
        chatCompletionsTranscriptSha256: "a".repeat(64),
      },
    };
    expect(
      getHarnessRoute("POST", "/v1/chat/completions", loadHarnessHttpConfig(safe))
        ?.enabled,
    ).toBe(true);
  });
});

import { describe, expect, it } from "vitest";

async function loadRouteModule() {
  const modulePath = "../src/gateway/http/route-registry.js";
  return await import(modulePath).catch(() => ({} as Record<string, unknown>));
}

async function loadConfigModule() {
  const modulePath = "../src/gateway/http/config.js";
  return await import(modulePath).catch(() => ({} as Record<string, unknown>));
}

describe("P0-05 frozen HTTP route policy", () => {
  it("pins the approved Phase 0 HTTP limits", async () => {
    const module = await loadConfigModule();
    expect(typeof module.loadHarnessHttpConfig).toBe("function");
    const config = await (module.loadHarnessHttpConfig as () => Promise<Record<string, unknown>>)();

    expect(config).toMatchObject({
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
  });

  it("enables only the approved default provider-compatible routes", async () => {
    const configModule = await loadConfigModule();
    const routeModule = await loadRouteModule();
    expect(typeof configModule.loadHarnessHttpConfig).toBe("function");
    expect(typeof routeModule.getHarnessRoute).toBe("function");
    const config = await (configModule.loadHarnessHttpConfig as () => Promise<unknown>)();
    const getRoute = routeModule.getHarnessRoute as (
      method: string,
      path: string,
      config: unknown,
    ) => { enabled: boolean; paid: boolean; streamingAllowed: boolean } | null;

    expect(getRoute("POST", "/v1/messages", config)).toMatchObject({
      enabled: true,
      paid: true,
      streamingAllowed: true,
    });
    expect(getRoute("POST", "/v1/messages/count_tokens", config)).toMatchObject({
      enabled: true,
      paid: false,
      streamingAllowed: false,
    });
    expect(getRoute("POST", "/v1/responses", config)).toMatchObject({
      enabled: true,
      paid: true,
      streamingAllowed: true,
    });
    expect(getRoute("POST", "/v1/chat/completions", config)).toMatchObject({
      enabled: false,
      paid: true,
      streamingAllowed: true,
    });
    expect(getRoute("GET", "/v1/responses", config)).toBeNull();
    expect(getRoute("POST", "/v1/unknown", config)).toBeNull();
  });

  it("requires transcript evidence before Chat Completions can be enabled", async () => {
    const module = await loadConfigModule();
    expect(typeof module.parseHarnessHttpConfig).toBe("function");
    const parse = module.parseHarnessHttpConfig as (
      input: Record<string, unknown>,
    ) => unknown;
    const base = {
      schemaVersion: 1,
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
      enabledRoutes: [
        "/v1/messages",
        "/v1/messages/count_tokens",
        "/v1/responses",
        "/v1/chat/completions",
      ],
      routeEvidence: {},
    };

    expect(() => parse(base)).toThrow(/transcript/i);
    expect(() =>
      parse({
        ...base,
        routeEvidence: {
          chatCompletionsTranscriptSha256: "a".repeat(64),
        },
      }),
    ).not.toThrow();
  });
});

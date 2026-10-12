import { describe, expect, it, vi } from "vitest";
import {
  assertDemoModelPrices,
  checkInstallationContentsWrite,
  readDemoInstallationId,
} from "../src/preflight.js";

describe("demo preflight hardening", () => {
  it("reads the connected installation recorded for the configured demo organization", async () => {
    const run = vi.fn(async () => ({ stdout: "456789\n", stderr: "" }));
    await expect(readDemoInstallationId({
      databaseUrl: "postgresql://admin@localhost/demo",
      organizationId: "00000000-0000-4000-8000-000000000123",
      runCommandImpl: run,
    })).resolves.toBe(456789);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toBe("psql");
    expect(JSON.stringify(run.mock.calls[0])).toContain("github_installations");
    expect(JSON.stringify(run.mock.calls[0])).toContain("00000000-0000-4000-8000-000000000123");
  });

  it("checks the accepted installation permission endpoint, not GET /app", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => new Response(JSON.stringify({ permissions: { contents: "write" } }), { status: 200 }));
    await checkInstallationContentsWrite({ installationId: 456789, appJwt: "jwt", fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("https://api.github.com/app/installations/456789");
  });

  it("tells the owner to accept a newly requested Contents permission when the installation still has read", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ permissions: { contents: "read" } }), { status: 200 }));
    await expect(checkInstallationContentsWrite({ installationId: 456789, appJwt: "jwt", fetchImpl })).rejects.toThrow(
      "Accept the new Contents permission on the dhara-coding-agent installation (GitHub → Settings → Applications → Installed GitHub Apps).",
    );
  });

  it.each([undefined, "", "   ", "{}"])("rejects absent or empty model pricing: %j", (raw) => {
    expect(() => assertDemoModelPrices(raw, "anthropic/execution", "anthropic/planning")).toThrow(/HARNESS_MODEL_PRICES_JSON/);
  });

  it("requires prices for both execution and planning models", () => {
    const executionOnly = JSON.stringify({
      "anthropic/execution": { inputUsdPerMillionTokens: 3, outputUsdPerMillionTokens: 15, defaultMaxOutputTokens: 4096 },
    });
    expect(() => assertDemoModelPrices(executionOnly, "anthropic/execution", "anthropic/planning")).toThrow(/anthropic\/planning/);

    const planningOnly = JSON.stringify({
      "anthropic/planning": { inputUsdPerMillionTokens: 3, outputUsdPerMillionTokens: 15, defaultMaxOutputTokens: 4096 },
    });
    expect(() => assertDemoModelPrices(planningOnly, "anthropic/execution", "anthropic/planning")).toThrow(/anthropic\/execution/);
  });

  it("accepts explicit list prices for both configured models", () => {
    const prices = JSON.stringify({
      "anthropic/execution": { inputUsdPerMillionTokens: 3, outputUsdPerMillionTokens: 15, defaultMaxOutputTokens: 4096 },
      "anthropic/planning": { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 5, defaultMaxOutputTokens: 2048 },
    });
    expect(() => assertDemoModelPrices(prices, "anthropic/execution", "anthropic/planning")).not.toThrow();
  });
});

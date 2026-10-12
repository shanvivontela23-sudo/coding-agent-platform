import { describe, expect, it, vi } from "vitest";
import { runDemoPreflight, type DemoPreflightDependencies } from "../src/preflight.js";

function dependencies(): DemoPreflightDependencies {
  return {
    checkDatabase: vi.fn(async () => undefined),
    checkModelPrices: vi.fn(async () => undefined),
    checkSupabase: vi.fn(async () => undefined),
    checkGitHubContentsWrite: vi.fn(async () => undefined),
    checkE2BListOnly: vi.fn(async () => undefined),
    checkLiteLLM: vi.fn(async () => undefined),
    checkTunnel: vi.fn(async () => undefined),
    checkGatewayToken: vi.fn(async () => undefined),
    checkWorkerClaimRollback: vi.fn(async () => undefined),
  };
}

describe("demo preflight", () => {
  it("runs every approved readiness check without a sandbox-create dependency", async () => {
    const deps = dependencies();
    const result = await runDemoPreflight(deps);
    expect(result.map((item) => item.name)).toEqual([
      "database roles and migrations",
      "model list prices",
      "Supabase",
      "GitHub App Contents: Read and write",
      "E2B authentication (list only)",
      "LiteLLM",
      "ngrok gateway tunnel",
      "gateway token minting",
      "worker claim rollback dry-run",
    ]);
    expect(result.every((item) => item.ok)).toBe(true);
    expect(Object.keys(deps).some((key) => /create.*sandbox/i.test(key))).toBe(false);
  });

  it("returns the failed check name and sanitized message without skipping later checks", async () => {
    const deps = dependencies();
    vi.mocked(deps.checkGitHubContentsWrite).mockRejectedValue(new Error("Contents permission is read"));
    const result = await runDemoPreflight(deps);
    expect(result.find((item) => item.name.startsWith("GitHub"))).toEqual({ name: "GitHub App Contents: Read and write", ok: false, message: "Contents permission is read" });
    expect(deps.checkWorkerClaimRollback).toHaveBeenCalledTimes(1);
  });
});

import { describe, expect, it, vi } from "vitest";
import type { DemoConfig } from "../src/config.js";
import {
  assertDemoModelPrice,
  checkDemoGitHubContentsWrite,
  checkLiteLLMHealth,
  runDemoPreflight,
  workerClaimRollbackSql,
  type DemoPreflightDependencies,
} from "../src/preflight.js";

function dependencies(): DemoPreflightDependencies {
  return {
    checkAppPorts: vi.fn(async () => undefined),
    checkDatabase: vi.fn(async () => undefined),
    checkSupabase: vi.fn(async () => undefined),
    checkGitHubContentsWrite: vi.fn(async () => undefined),
    checkPlanningModelPrice: vi.fn(async () => undefined),
    checkExecutionModelPrice: vi.fn(async () => undefined),
    checkE2BListOnly: vi.fn(async () => undefined),
    checkLiteLLM: vi.fn(async () => undefined),
    checkTunnel: vi.fn(async () => undefined),
    checkGatewayToken: vi.fn(async () => undefined),
    checkWorkerClaimRollback: vi.fn(async () => undefined),
  };
}

function config(values: Readonly<Record<string, string>> = {}): DemoConfig {
  return {
    apiPort: 3101,
    webPort: 3000,
    planningBudgetUsd: 1,
    executionBudgetUsd: 2,
    values: {
      DEMO_DATABASE_ADMIN_URL: "postgresql://admin@example.test/dhara",
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: "unused",
      TASK_MODEL_NAME: "planning-model",
      TASK_EXECUTION_MODEL: "execution-model",
      HARNESS_MODEL_PRICES_JSON: JSON.stringify({
        "planning-model": { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2, defaultMaxOutputTokens: 4096 },
        "execution-model": { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2, defaultMaxOutputTokens: 4096 },
      }),
      ...values,
    },
  };
}

function commandResult(stdout: string) {
  return { stdout, stderr: "" };
}

describe("demo preflight", () => {
  it("runs every approved readiness check without a sandbox-create dependency", async () => {
    const deps = dependencies();
    const result = await runDemoPreflight(deps);
    expect(result.map((item) => item.name)).toEqual([
      "API and web ports",
      "database roles and migrations",
      "Supabase",
      "GitHub App Contents: Read and write",
      "planning model price",
      "execution model price",
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

  it("uses a valid worker lease and keeps the dry-run inside BEGIN and ROLLBACK", () => {
    const sql = workerClaimRollbackSql();
    const match = sql.match(/claim_task_execution\('demo-preflight',(\d+)\)/);
    expect(match).not.toBeNull();
    const leaseSeconds = Number(match?.[1]);
    expect(leaseSeconds).toBeGreaterThanOrEqual(5);
    expect(leaseSeconds).toBeLessThanOrEqual(3600);
    expect(leaseSeconds).toBe(30);
    expect(sql).toMatch(/^BEGIN;/);
    expect(sql).toMatch(/ROLLBACK;$/);
  });

  it("retries LiteLLM liveliness until it becomes healthy", async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    const sleep = vi.fn(async () => undefined);

    await expect(checkLiteLLMHealth({
      fetchImpl: fetchImpl as typeof fetch,
      sleep,
      timeoutMs: 60_000,
      retryDelayMs: 1,
      now: (() => { let value = 0; return () => { value += 1_000; return value; }; })(),
      headers: { authorization: "Bearer test" },
    })).resolves.toBeUndefined();

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("reports the operator-facing LiteLLM log hint after the retry window", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("fetch failed"); });
    const sleep = vi.fn(async () => undefined);

    await expect(checkLiteLLMHealth({
      fetchImpl: fetchImpl as typeof fetch,
      sleep,
      timeoutMs: 60_000,
      retryDelayMs: 1,
      now: (() => { let value = 0; return () => { value += 30_000; return value; }; })(),
      headers: {},
    })).rejects.toThrow("LiteLLM did not become healthy; see `docker logs http-gateway-litellm-1`");
  });

  it("requires a price for the planning model and names that model without echoing price JSON", () => {
    const prices = "{}";
    expect(() => assertDemoModelPrice(prices, "planning-model", "planning")).toThrow("Planning model planning-model has no configured price.");
    try { assertDemoModelPrice(prices, "planning-model", "planning"); } catch (error) {
      expect(String(error)).not.toContain(prices);
    }
  });

  it("requires a price for the execution model separately", () => {
    const prices = JSON.stringify({
      "planning-model": { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2, defaultMaxOutputTokens: 4096 },
    });
    expect(() => assertDemoModelPrice(prices, "execution-model", "execution")).toThrow("Execution model execution-model has no configured price.");
  });

  it("rejects an all-zero configured price so demo cost cannot silently display zero", () => {
    const prices = JSON.stringify({
      "planning-model": { inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0, defaultMaxOutputTokens: 4096 },
    });
    expect(() => assertDemoModelPrice(prices, "planning-model", "planning")).toThrow("Planning model planning-model has no configured price.");
  });

  it("accepts valid prices for each configured model", () => {
    const prices = config().values.HARNESS_MODEL_PRICES_JSON!;
    expect(() => assertDemoModelPrice(prices, "planning-model", "planning")).not.toThrow();
    expect(() => assertDemoModelPrice(prices, "execution-model", "execution")).not.toThrow();
  });

  it("asks the operator to connect GitHub when no installation is recorded", async () => {
    const runCommandImpl = vi.fn(async () => commandResult(""));
    await expect(checkDemoGitHubContentsWrite(config(), {
      runCommandImpl,
      permissionReader: { getInstallationPermissions: vi.fn() },
    })).rejects.toThrow("Connect the GitHub App from Dhara home before the demo.");
    expect(runCommandImpl).toHaveBeenCalledWith("psql", expect.arrayContaining(["postgresql://admin@example.test/dhara"]));
  });

  it("requires DEMO_ORGANIZATION_ID when more than one connected installation exists", async () => {
    const runCommandImpl = vi.fn(async () => commandResult([
      "00000000-0000-4000-8000-000000000001\t701\tconnected",
      "00000000-0000-4000-8000-000000000002\t702\tconnected",
    ].join("\n")));
    await expect(checkDemoGitHubContentsWrite(config(), {
      runCommandImpl,
      permissionReader: { getInstallationPermissions: vi.fn() },
    })).rejects.toThrow("More than one GitHub installation is connected; set DEMO_ORGANIZATION_ID to choose one.");
  });

  it("uses DEMO_ORGANIZATION_ID to select the recorded installation", async () => {
    const runCommandImpl = vi.fn(async () => commandResult([
      "00000000-0000-4000-8000-000000000001\t701\tconnected",
      "00000000-0000-4000-8000-000000000002\t702\tconnected",
    ].join("\n")));
    const getInstallationPermissions = vi.fn(async () => ({ contents: "write" as const }));
    await expect(checkDemoGitHubContentsWrite(config({ DEMO_ORGANIZATION_ID: "00000000-0000-4000-8000-000000000002" }), {
      runCommandImpl,
      permissionReader: { getInstallationPermissions },
    })).resolves.toBeUndefined();
    expect(getInstallationPermissions).toHaveBeenCalledWith(702, { bypassCache: true });
  });

  it("reuses the disconnected message for a recorded disconnected installation", async () => {
    const runCommandImpl = vi.fn(async () => commandResult("00000000-0000-4000-8000-000000000001\t701\tdisconnected"));
    await expect(checkDemoGitHubContentsWrite(config(), {
      runCommandImpl,
      permissionReader: { getInstallationPermissions: vi.fn() },
    })).rejects.toThrow("GitHub installation is disconnected.");
  });

  it("passes through the disconnected message returned by GitHub", async () => {
    const runCommandImpl = vi.fn(async () => commandResult("00000000-0000-4000-8000-000000000001\t701\tconnected"));
    const getInstallationPermissions = vi.fn(async () => { throw new Error("GitHub installation is disconnected."); });
    await expect(checkDemoGitHubContentsWrite(config(), {
      runCommandImpl,
      permissionReader: { getInstallationPermissions },
    })).rejects.toThrow("GitHub installation is disconnected.");
  });

  it("tells the operator to accept Contents write on the installation when GitHub reports read", async () => {
    const runCommandImpl = vi.fn(async () => commandResult("00000000-0000-4000-8000-000000000001\t701\tconnected"));
    const getInstallationPermissions = vi.fn(async () => ({ contents: "read" as const }));
    await expect(checkDemoGitHubContentsWrite(config(), {
      runCommandImpl,
      permissionReader: { getInstallationPermissions },
    })).rejects.toThrow("Accept the new Contents permission on the dhara-coding-agent installation (GitHub → Settings → Applications → Installed GitHub Apps).");
  });
});

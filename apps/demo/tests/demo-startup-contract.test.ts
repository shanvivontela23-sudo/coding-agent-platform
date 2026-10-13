import { createServer } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { LiteLLMAdapter } from "../../../evals/src/gateway/litellm-adapter.js";
import type { DemoConfig } from "../src/config.js";
import { createDemoLaunchPlan } from "../src/launcher.js";
import {
  createLiveDemoPreflight,
  runDemoPreflight,
  type DemoPreflightDependencies,
} from "../src/preflight.js";

function config(apiPort = 3101, webPort = 3000): DemoConfig {
  return {
    apiPort,
    webPort,
    planningBudgetUsd: 1,
    executionBudgetUsd: 2,
    values: {
      DEMO_API_DATABASE_URL: "postgresql://coding_agent_api:api@127.0.0.1:5432/coding_agent",
      DEMO_WORKER_DATABASE_URL: "postgresql://coding_agent_worker:worker@127.0.0.1:5432/coding_agent",
      LITELLM_MASTER_KEY: "dummy-litellm-token",
      MODEL_GATEWAY_RUN_TOKEN_SECRET: "dummy-run-token-secret-that-is-long-enough",
    },
  };
}

function readyDependencies(): DemoPreflightDependencies {
  return {
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
    checkAppPorts: vi.fn(async () => undefined),
  } as unknown as DemoPreflightDependencies;
}

describe("demo startup contract", () => {
  it("keeps the real API and worker LiteLLM URLs valid for the adapter", () => {
    const plan = createDemoLaunchPlan(config(), "https://demo-tunnel.ngrok.app");

    expect(() => new LiteLLMAdapter({
      baseUrl: plan.api.env.TASK_MODEL_GATEWAY_BASE_URL ?? "",
      adminToken: "dummy-api-token",
    })).not.toThrow();
    expect(() => new LiteLLMAdapter({
      baseUrl: plan.worker.env.LITELLM_GATEWAY_URL ?? "",
      adminToken: "dummy-worker-token",
    })).not.toThrow();
  });

  it("includes app-port availability in the preflight list", async () => {
    const result = await runDemoPreflight(readyDependencies());
    expect(result.map((item) => item.name)).toContain("API and web ports");
    expect(result).toHaveLength(11);
  });

  it("reports the exact operator command when a demo port is already listening", async () => {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not expose a TCP port");

    try {
      const deps = createLiveDemoPreflight(
        config(address.port, 3000),
        "https://demo-tunnel.ngrok.app",
      );
      const checkAppPorts = (deps as unknown as { checkAppPorts?: () => Promise<void> }).checkAppPorts;
      expect(checkAppPorts).toBeTypeOf("function");
      if (!checkAppPorts) return;

      await expect(checkAppPorts()).rejects.toThrow(
        `Port ${address.port} is already in use; stop the process using it (\`lsof -iTCP:${address.port} -sTCP:LISTEN\`)`,
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });
});

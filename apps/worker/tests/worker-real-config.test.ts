import { describe, expect, it } from "vitest";
import { loadRealWorkerConfig } from "../src/worker-config.js";

describe("real worker configuration", () => {
  it("fails fast with one clear list of every missing required setting", () => {
    expect(() => loadRealWorkerConfig({ DATABASE_URL: "postgresql://coding_agent_worker:x@localhost/db", TASK_EXECUTION_WORKER_ID: "worker-1" })).toThrowError(/Missing worker configuration:.*E2B_API_KEY.*TASK_EXECUTION_MODEL.*TASK_EXECUTION_GATEWAY_URL.*GITHUB_APP_ID.*PROJECT_STORAGE_ROOT/s);
  });

  it("parses a complete configuration without defaulting execution timeouts", () => {
    const config = loadRealWorkerConfig({
      DATABASE_URL: "postgresql://coding_agent_worker:x@localhost/db",
      TASK_EXECUTION_WORKER_ID: "worker-1",
      E2B_API_KEY: "e2b-test",
      TASK_EXECUTION_MODEL: "model-test",
      TASK_EXECUTION_CODEX_VERSION: "0.90.0",
      TASK_EXECUTION_GATEWAY_URL: "https://gateway.example.test",
      MODEL_GATEWAY_RUN_TOKEN_SECRET: "a".repeat(32),
      GATEWAY_STORE_DIR: "/tmp/gateway",
      HARNESS_CALL_STORE_DIR: "/tmp/calls",
      LITELLM_GATEWAY_URL: "http://127.0.0.1:4000",
      LITELLM_ADMIN_TOKEN: "admin-test",
      GITHUB_APP_ID: "12345",
      GITHUB_APP_PRIVATE_KEY: "private-key-test",
      PROJECT_STORAGE_ROOT: "/tmp/storage",
    });
    expect(config.workerId).toBe("worker-1");
    expect(config.model).toBe("model-test");
    expect(config).not.toHaveProperty("timeoutMs");
  });
});

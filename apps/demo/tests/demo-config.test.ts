import { describe, expect, it } from "vitest";
import { DEMO_DEFAULTS, loadDemoEnvironment, publicDemoSummary } from "../src/config.js";

describe("demo configuration", () => {
  it("uses the approved central demo caps and owner ports", () => {
    expect(DEMO_DEFAULTS).toMatchObject({ apiPort: 3101, webPort: 3000, planningBudgetUsd: 1, executionBudgetUsd: 2 });
  });

  it("lists every missing variable by name without echoing any supplied secret", () => {
    const secret = "super-secret-value-that-must-not-print";
    const result = loadDemoEnvironment({ SESSION_SIGNING_SECRET: secret });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected missing demo configuration");
    expect(result.missing).toContain("SUPABASE_URL");
    expect(result.missing).toContain("E2B_API_KEY");
    expect(result.message).toContain("SUPABASE_URL");
    expect(result.message).not.toContain(secret);
  });

  it("parses a git-ignored dotenv payload without exposing values in the public summary", () => {
    const value = "gh-secret-123";
    const env = loadDemoEnvironment({
      DEMO_DATABASE_ADMIN_URL: "postgresql://postgres:postgres@127.0.0.1:5432/coding_agent",
      DEMO_API_DATABASE_URL: "postgresql://coding_agent_api:api@127.0.0.1:5432/coding_agent",
      DEMO_WORKER_DATABASE_URL: "postgresql://coding_agent_worker:worker@127.0.0.1:5432/coding_agent",
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_ANON_KEY: value,
      SUPABASE_FLOW_SECRET: value,
      SESSION_SIGNING_SECRET: value,
      GITHUB_APP_ID: "123",
      GITHUB_APP_SLUG: "dhara",
      GITHUB_APP_CLIENT_ID: value,
      GITHUB_APP_CLIENT_SECRET: value,
      GITHUB_APP_PRIVATE_KEY: value,
      E2B_API_KEY: value,
      TASK_EXECUTION_MODEL: "model",
      TASK_EXECUTION_CODEX_VERSION: "codex",
      MODEL_GATEWAY_RUN_TOKEN_SECRET: value,
      LITELLM_MASTER_KEY: value,
      ANTHROPIC_API_KEY: value,
      TASK_MODEL_NAME: "anthropic/model",
      NGROK_AUTHTOKEN: value,
    });
    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error(env.message);
    const summary = publicDemoSummary(env.config);
    expect(summary).toContain("API: http://localhost:3101");
    expect(summary).toContain("Planning cap: $1.00");
    expect(summary).toContain("Implementation cap: $2.00");
    expect(summary).not.toContain(value);
  });
});

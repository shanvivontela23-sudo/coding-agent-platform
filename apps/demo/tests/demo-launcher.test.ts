import { describe, expect, it } from "vitest";
import { createDemoLaunchPlan, publicLaunchPlan } from "../src/launcher.js";
import { loadDemoEnvironment } from "../src/config.js";

const secret = "demo-secret-that-must-not-print";
function config(extra: Record<string, string> = {}) {
  const result = loadDemoEnvironment({
    ...extra,
    DEMO_DATABASE_ADMIN_URL: "postgresql://postgres:postgres@127.0.0.1:5432/coding_agent",
    DEMO_API_DATABASE_URL: "postgresql://coding_agent_api:api@127.0.0.1:5432/coding_agent",
    DEMO_WORKER_DATABASE_URL: "postgresql://coding_agent_worker:worker@127.0.0.1:5432/coding_agent",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_ANON_KEY: secret,
    SUPABASE_FLOW_SECRET: secret,
    SESSION_SIGNING_SECRET: secret,
    GITHUB_APP_ID: "123",
    GITHUB_APP_SLUG: "dhara",
    GITHUB_APP_CLIENT_ID: secret,
    GITHUB_APP_CLIENT_SECRET: secret,
    GITHUB_APP_PRIVATE_KEY: secret,
    E2B_API_KEY: secret,
    E2B_TEMPLATE_ID: "tmpl-test",
    TASK_EXECUTION_MODEL: "anthropic/demo",
    TASK_EXECUTION_CODEX_VERSION: "1.0.0",
    MODEL_GATEWAY_RUN_TOKEN_SECRET: secret,
    LITELLM_MASTER_KEY: secret,
    POSTGRES_PASSWORD: secret,
    ANTHROPIC_API_KEY: secret,
    TASK_MODEL_NAME: "anthropic/demo",
    HARNESS_MODEL_PRICES_JSON: JSON.stringify({
      "anthropic/demo": { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2, defaultMaxOutputTokens: 4096 },
    }),
    NGROK_AUTHTOKEN: secret,
  });
  if (!result.ok) throw new Error(result.message);
  return result.config;
}

describe("demo launcher plan", () => {
  it("starts with only E2B_TEMPLATE_ID and forwards optional per-stack templates to the worker", () => {
    const plain = createDemoLaunchPlan(config(), "https://demo-tunnel.ngrok.app");
    expect(plain.worker.env.E2B_TEMPLATE_ID).toBe("tmpl-test");
    expect(Object.keys(plain.worker.env).filter((name) => name.startsWith("E2B_TEMPLATE_"))).toEqual(["E2B_TEMPLATE_ID"]);
    const keyed = createDemoLaunchPlan(config({ E2B_TEMPLATE_TYPESCRIPT_NODE: "tmpl-ts" }), "https://demo-tunnel.ngrok.app");
    expect(keyed.worker.env.E2B_TEMPLATE_TYPESCRIPT_NODE).toBe("tmpl-ts");
    expect(keyed.api.env.E2B_TEMPLATE_TYPESCRIPT_NODE).toBeUndefined();
  });

  it("starts API 3101, web 3000, and the real worker against the HTTPS gateway tunnel", () => {
    const plan = createDemoLaunchPlan(config(), "https://demo-tunnel.ngrok.app");
    expect(plan.api.env).toMatchObject({ PORT: "3101", API_ORIGIN: "http://localhost:3101", DEMO_MODE: "1", TASK_MODEL_BUDGET_USD: "1", TASK_EXECUTION_BUDGET_USD: "2" });
    expect(plan.web.env).toMatchObject({ NEXT_PUBLIC_API_ORIGIN: "http://localhost:3101" });
    expect(plan.worker.env).toMatchObject({ DATABASE_URL: "postgresql://coding_agent_worker:worker@127.0.0.1:5432/coding_agent", TASK_EXECUTION_GATEWAY_URL: "https://demo-tunnel.ngrok.app" });
    expect(plan.worker.env.TASK_EXECUTION_FAKE_RUNNER).toBeUndefined();
    expect(plan.compose.args).toContain("evals/deploy/http-gateway/compose.local.yaml");
    expect(plan.ngrok.args).toEqual(expect.arrayContaining(["http", "8080"]));
  });

  it("gives each child only the credentials it needs", () => {
    const plan = createDemoLaunchPlan(config(), "https://demo-tunnel.ngrok.app");
    expect(plan.web.env).toEqual({ NEXT_PUBLIC_API_ORIGIN: "http://localhost:3101", API_INTERNAL_ORIGIN: "http://127.0.0.1:3101", PORT: "3000" });
    expect(plan.api.env.DEMO_DATABASE_ADMIN_URL).toBeUndefined();
    expect(plan.api.env.DEMO_WORKER_DATABASE_URL).toBeUndefined();
    expect(plan.api.env.E2B_API_KEY).toBeUndefined();
    expect(plan.api.env.NGROK_AUTHTOKEN).toBeUndefined();
    expect(plan.worker.env.DEMO_DATABASE_ADMIN_URL).toBeUndefined();
    expect(plan.worker.env.SUPABASE_FLOW_SECRET).toBeUndefined();
    expect(plan.worker.env.GITHUB_APP_CLIENT_SECRET).toBeUndefined();
    expect(plan.compose.env.SUPABASE_FLOW_SECRET).toBeUndefined();
    expect(plan.ngrok.env).toEqual({ NGROK_AUTHTOKEN: secret });
  });

  it("renders a public launch summary without secret values", () => {
    expect(publicLaunchPlan(createDemoLaunchPlan(config(), "https://demo-tunnel.ngrok.app"), config())).not.toContain(secret);
  });
});

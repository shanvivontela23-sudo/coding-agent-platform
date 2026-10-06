import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  E2B_NETWORK_SMOKE_ASSERTIONS,
  HTTP_GATEWAY_SMOKE_ASSERTIONS,
  requireLiveSmoke,
  sanitizedSmokeEvidence,
} from "../smoke/contracts.js";

const requiredHttpAssertions = [
  "hash_locked_litellm_install",
  "pinned_harness_transcripts",
  "bearer_auth",
  "x_api_key_auth",
  "claim_derived_run_id",
  "main_background_model_allowlist",
  "unknown_route_refusal",
  "chat_completions_disabled",
  "incremental_sse_through_caddy",
  "terminal_stream_usage",
  "first_response_timeout",
  "stream_idle_timeout",
  "maximum_stream_duration",
  "non_streaming_timeout",
  "zero_cost_token_count",
  "token_parity_openai_uncached",
  "token_parity_openai_cached",
  "token_parity_anthropic_uncached",
  "token_parity_anthropic_cached",
  "delayed_spend_reconciliation",
  "intentional_reconciliation_mismatch",
  "distinct_harness_call_ids",
  "crash_rerun_spend_retained",
  "per_run_spend_cap",
  "spend_reserved_refusal_count",
  "auth_before_body",
  "request_body_limit",
  "per_run_rate_limit",
] as const;

const requiredNetworkAssertions = [
  "gateway_https_reachable",
  "non_allowlisted_hostname_blocked",
  "raw_ipv4_blocked",
  "outside_dns_name_blocked",
  "ipv6_egress_blocked",
] as const;

describe("live smoke contract", () => {
  it("fails closed unless LIVE_SMOKE=1", () => {
    expect(() => requireLiveSmoke({})).toThrow("LIVE_SMOKE=1");
    expect(() => requireLiveSmoke({ LIVE_SMOKE: "0" })).toThrow("LIVE_SMOKE=1");
    expect(() => requireLiveSmoke({ LIVE_SMOKE: "1" })).not.toThrow();
  });

  it("enumerates every HTTP and network assertion carried into live validation", () => {
    expect(HTTP_GATEWAY_SMOKE_ASSERTIONS).toEqual(requiredHttpAssertions);
    expect(E2B_NETWORK_SMOKE_ASSERTIONS).toEqual(requiredNetworkAssertions);
  });

  it("sanitizes evidence recursively before it can be written", () => {
    const evidence = sanitizedSmokeEvidence({
      assertion: "bearer_auth",
      ok: true,
      authorization: "Bearer must-not-survive",
      apiKey: "must-not-survive",
      nested: { token: "must-not-survive", count: 2 },
      safe: "status-only",
    });
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain("must-not-survive");
    expect(serialized).not.toContain("Bearer");
    expect(evidence).toMatchObject({ safe: "status-only", nested: { count: 2 } });
  });

  it("keeps live smoke opt-in scripts out of public CI", async () => {
    const [packageJson, workflow, httpSmoke, networkSmoke] = await Promise.all([
      readFile("package.json", "utf8"),
      readFile(".github/workflows/ci.yml", "utf8"),
      readFile("evals/smoke/http-gateway-smoke.ts", "utf8"),
      readFile("evals/smoke/e2b-network-smoke.ts", "utf8"),
    ]);
    const scripts = (JSON.parse(packageJson) as { scripts: Record<string, string> }).scripts;
    expect(scripts["smoke:http-gateway"]).toContain("http-gateway-smoke.ts");
    expect(scripts["smoke:e2b-network"]).toContain("e2b-network-smoke.ts");
    expect(workflow).not.toContain("smoke:http-gateway");
    expect(workflow).not.toContain("smoke:e2b-network");
    expect(httpSmoke).toContain("python -m pip install --require-hashes -r evals/litellm/requirements.txt");
    expect(httpSmoke).toContain("spend_reserved");
    expect(httpSmoke).toContain("token_parity_openai_cached");
    expect(httpSmoke).toContain("token_parity_anthropic_cached");
    expect(networkSmoke).toContain("non_allowlisted_hostname_blocked");
    expect(networkSmoke).toContain("raw_ipv4_blocked");
    expect(networkSmoke).toContain("outside_dns_name_blocked");
    expect(networkSmoke).toContain("ipv6_egress_blocked");
  });

  it("keeps the Phase 0 boundary docs synchronized with the HTTP gateway and live smoke", async () => {
    const [gatewayDoc, sandboxDoc] = await Promise.all([
      readFile("evals/docs/phase-0/model-gateway.md", "utf8"),
      readFile("evals/docs/phase-0/sandbox.md", "utf8"),
    ]);
    expect(gatewayDoc).toContain("evals/src/gateway/http/server.ts");
    expect(gatewayDoc).toContain("evals/smoke/http-gateway-smoke.ts");
    expect(gatewayDoc).toContain("truncated");
    expect(sandboxDoc).toContain("evals/smoke/e2b-network-smoke.ts");
    expect(sandboxDoc).toContain("::/0");
  });
});

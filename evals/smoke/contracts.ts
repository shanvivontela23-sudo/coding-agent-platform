import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export const HTTP_GATEWAY_SMOKE_ASSERTIONS = [
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

export const E2B_NETWORK_SMOKE_ASSERTIONS = [
  "gateway_https_reachable",
  "non_allowlisted_hostname_blocked",
  "raw_ipv4_blocked",
  "outside_dns_name_blocked",
  "ipv6_egress_blocked",
] as const;

export type SmokeAssertionId =
  | (typeof HTTP_GATEWAY_SMOKE_ASSERTIONS)[number]
  | (typeof E2B_NETWORK_SMOKE_ASSERTIONS)[number];

export type SmokeEvidenceRow = {
  readonly assertion: SmokeAssertionId;
  readonly ok: boolean;
  readonly detail?: Readonly<Record<string, unknown>>;
};

const sensitiveKey = /(authorization|api.?key|token|secret|password|credential|prompt|request.?body|response.?body|model.?output)/i;

function sanitize(value: unknown, key?: string): unknown {
  if (key && sensitiveKey.test(key)) return undefined;
  if (Array.isArray(value)) {
    return value.map((entry) => sanitize(entry)).filter((entry) => entry !== undefined);
  }
  if (typeof value === "object" && value !== null) {
    const output: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      const sanitized = sanitize(childValue, childKey);
      if (sanitized !== undefined) output[childKey] = sanitized;
    }
    return output;
  }
  if (typeof value === "string") {
    return value
      .replace(/Bearer\s+[^\s,;]+/gi, "[redacted]")
      .replace(/\bsk-[A-Za-z0-9._-]{6,}\b/g, "[redacted]");
  }
  return value;
}

export function sanitizedSmokeEvidence<T>(value: T): T {
  return sanitize(value) as T;
}

export function requireLiveSmoke(
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  if (env.LIVE_SMOKE !== "1") {
    throw new Error("LIVE_SMOKE=1 is required for credentialed live smoke");
  }
}

export async function writeSmokeEvidence(
  name: string,
  rows: readonly SmokeEvidenceRow[],
): Promise<string> {
  const path = resolve("evals", "results", "smoke", `${name}.json`);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const payload = sanitizedSmokeEvidence({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    rows,
  });
  await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, path);
  return path;
}

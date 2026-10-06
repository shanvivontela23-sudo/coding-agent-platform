# Phase 0 live smoke runners

These commands are intentionally excluded from public CI. They make credentialed calls and may incur provider/E2B charges, so both require `LIVE_SMOKE=1` and fail closed otherwise.

No live smoke has been run by PR C.

## Before running

The operator must first:

1. provision the reviewed gateway stack and HTTPS hostname;
2. fund OpenAI and Anthropic with the agreed **$25 prepaid each**, auto-reload off;
3. create an E2B account/key;
4. record sanitized protocol transcripts with the exact pinned Claude Code and Codex versions and review their SHA-256 digests;
5. confirm the harness licences/terms permit the intended commercial multi-tenant use before benchmark results are used to choose a harness;
6. source the host-only secret environment without pasting any secret into chat or committing it.

The deployment binds LiteLLM management access to loopback only for the trusted operator runner. The sandbox never receives the LiteLLM master key, provider keys, E2B key, or GitHub credentials.

## HTTP gateway smoke

Run from the trusted VM host/repository checkout, not from an E2B guest. The runner's internal management-client variable is named `LITELLM_ADMIN_TOKEN`; use the same single master credential rather than creating a second secret:

```text
export LITELLM_ADMIN_TOKEN="$LITELLM_MASTER_KEY"
LIVE_SMOKE=1 pnpm smoke:http-gateway
```

Required smoke-only environment:

- `SMOKE_GATEWAY_BASE_URL` — public HTTPS Caddy URL;
- `SMOKE_LITELLM_BASE_URL` — trusted loopback LiteLLM URL, normally `http://127.0.0.1:4000`;
- `SMOKE_GATEWAY_STORE_DIR` and `SMOKE_HARNESS_CALL_STORE_DIR` — host paths backing the gateway state bind mount;
- `SMOKE_OPENAI_MODEL`, `SMOKE_ANTHROPIC_MODEL`, `SMOKE_BACKGROUND_MODEL` — exact model names used by the run;
- `SMOKE_CLAUDE_TRANSCRIPT_PATH`, `SMOKE_CLAUDE_TRANSCRIPT_SHA256`;
- `SMOKE_CODEX_TRANSCRIPT_PATH`, `SMOKE_CODEX_TRANSCRIPT_SHA256`;
- the normal trusted-host secrets `MODEL_GATEWAY_RUN_TOKEN_SECRET` and `LITELLM_MASTER_KEY` (aliased to `LITELLM_ADMIN_TOKEN` only for the smoke process as shown above).

The HTTP runner performs a **real** `python -m pip install --require-hashes -r evals/litellm/requirements.txt` preflight. It then creates disposable run-scoped LiteLLM keys/runs and validates the frozen HTTP contract.

For the carry-over token rule, the sequence is deliberate: it first compares the gateway call record against the matching LiteLLM spend row for OpenAI and Anthropic, uncached and cached. Cached probes must show `cachedInputTokens > 0`. Only after those four parity assertions does the runner execute the final reconciliation/mismatch checks. This makes the live evidence explicit before the exact-match rule is relied on as a gate.

The runner also counts observed HTTP `spend_reserved` refusals; at least one is required. Timeout mechanics use deterministic local application fixtures so the smoke run does not spend provider money trying to manufacture stalls. The public Caddy path is still used for real incremental SSE validation.

## E2B network smoke

Run separately:

```text
LIVE_SMOKE=1 pnpm smoke:e2b-network
```

The E2B sandbox starts directly in the coding-phase network policy: only the public gateway hostname is allowlisted, while IPv4 and IPv6 default routes are denied. The runner proves:

- the gateway HTTPS hostname is reachable;
- a non-allowlisted hostname is blocked;
- a raw IPv4 destination is blocked;
- a separate outside DNS hostname is blocked;
- direct IPv6 egress is blocked.

## Evidence handling

Both runners write only sanitized status/count evidence under ignored `evals/results/smoke/`. Prompt text, model output, authorization values, provider keys, run credentials, passwords, and E2B credentials are removed by the evidence sanitizer and must never be committed.

A failed or missing assertion makes the runner exit non-zero. Do not treat a partial smoke as Phase 0 evidence.

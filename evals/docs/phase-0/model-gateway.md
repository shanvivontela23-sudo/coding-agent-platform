# P0-04/P0-05 Model Gateway

Phase 0 owns the model boundary so benchmark harnesses never receive provider credentials and never talk to providers directly. P0-04 introduced the provider-neutral `ModelGateway`/LiteLLM control-plane adapter. P0-05 adds the harness-facing HTTP compatibility surface used by pinned CLI harnesses.

## Version and dependency pin

The LiteLLM proxy root requirement is pinned exactly in `evals/litellm/requirements.in`:

```text
litellm[proxy]==1.103.2
```

`evals/litellm/requirements.txt` is the fully resolved Python 3.12 lock with hashes for every artifact. Public CI verifies the lock with a `--dry-run --require-hashes` install. The reviewed live deployment and smoke path performs a real:

```text
python -m pip install --require-hashes -r evals/litellm/requirements.txt
```

Do not use an unpinned `latest` image/package or install from `requirements.in` for benchmark gate runs. A LiteLLM or resolved-dependency upgrade is an experiment change and must regenerate the lock and rerun the relevant evals.

## Trust and credential boundary

```text
sandbox / pinned harness
      |
      | short-lived signed run token only
      v
Caddy :443
      |
      v
Node harness HTTP gateway
      |
      | hidden run-scoped LiteLLM virtual key
      v
LiteLLM proxy
      |
      | provider credentials from LiteLLM process environment only
      v
model provider
```

Provider API keys are not accepted from the harness. They are not inserted into prompts, cost rows, benchmark manifests, sandbox environment variables, or this repository. Provider credentials belong only to the trusted LiteLLM host environment.

The sandbox receives only a signed run credential minted by `RunTokenService`. Run identity comes from that verified token, not from client headers or request bodies. The signing secret stays on the trusted host.

The Node composition is `evals/src/gateway/http/server.ts`. It fails closed if the run-token signing secret, LiteLLM URL/admin credential, durable store paths, or model list-price configuration is missing.

## Harness HTTP surface

The frozen route registry is `evals/config/http-gateway.json`.

- `POST /v1/messages` — enabled, paid, streaming allowed.
- `POST /v1/messages/count_tokens` — enabled, zero-cost/non-paid.
- `POST /v1/responses` — enabled, paid, streaming allowed.
- `POST /v1/chat/completions` — implemented but **disabled**.

`/v1/chat/completions` must remain disabled unless a sanitized transcript from the exact pinned benchmark harness demonstrates that the route is required and the reviewed transcript digest is added to route evidence. The protocol recorder stores only request/response shape metadata, never prompt contents, tool arguments, model output, or credentials.

Harness calls deliberately do not reuse control-plane idempotency semantics: repeated harness HTTP requests receive distinct server-generated call ids and each paid attempt remains accountable.

## Per-run spend cap and reservation

The default Phase 0 run cap is `$10` unless the run explicitly uses a smaller cap.

The HTTP gateway reserves budget before dispatch. The server composition uses `createListPriceCostEstimator`: it conservatively treats each UTF-8 request byte as one uncached input token and adds the requested `max_output_tokens`/`max_tokens` (or the configured model default) at current list price. The reservation is only a pre-dispatch guard; LiteLLM's persisted spend is authoritative after dispatch.

Reservations are held only for the short critical section needed to prevent same-process overbooking; upstream model work is never performed while that lock is held. A `spend_reserved` refusal is part of the live smoke evidence contract.

LiteLLM virtual-key budgets provide the second, upstream-side containment layer. Provider prepaid balances are an outer containment layer for the Phase 0 live run.

## Streaming lifecycle

The HTTP gateway passes SSE bytes through incrementally and observes events in parallel for usage accounting. A stream is `completed` only after the provider-specific terminal event is observed. If upstream EOF arrives without that terminal event, the call is recorded as `truncated`, not `completed`.

Timeout, interruption, failure, and truncated lifecycle states remain visible in the harness call record. Timeout/interrupted/truncated calls use LiteLLM's persisted usage/spend as the authoritative accounting fallback when client-facing terminal usage is unavailable.

Caddy is configured without response buffering; incremental delivery is still verified by live smoke rather than inferred from static configuration alone.

## Usage and spend reconciliation

Normalized usage has the same semantics across supported wire APIs:

- `inputTokens`: total input consumed;
- `cachedInputTokens`: cache-read subset;
- `cacheWriteInputTokens`: cache-write subset when exposed;
- `outputTokens` and `reasoningTokens`: corresponding provider counters when exposed.

OpenAI Responses uses `input_tokens` plus `input_tokens_details.cached_tokens`. Anthropic total input is normalized from base input plus cache-read and cache-creation input.

LiteLLM spend persistence is asynchronous. The reconciler therefore polls with bounded backoff and matches by the server-generated LiteLLM call id. Duplicate/unexpected rows, monetary differences above `$0.000001`, or token mismatches fail loudly. Failed non-2xx calls with no observed usage have a narrow zero-cost fallback only after the bounded window and only when no LiteLLM row exists; if a row exists it remains authoritative.

Before the Phase 0 benchmark relies on exact token equality as a gate, the live runner must prove gateway/LiteLLM parity for cached and uncached calls on both OpenAI and Anthropic. That evidence is implemented in `evals/smoke/http-gateway-smoke.ts`.

## Control-plane idempotency and crash recovery

The earlier `PersistentModelGateway` control-plane path still uses `(runId, idempotencyKey)` plus a request fingerprint. A completed control-plane call is persisted before return and an identical retry replays the stored response/cost rather than making another provider call. Reusing an idempotency key with a different request fingerprint is rejected.

This is separate from harness HTTP behavior. For harness attempts, a crashed attempt is rerun with a new call id and the earlier spend remains counted. The live smoke contract verifies that boundary.

## Deployment and live verification

The reviewed Phase 0 deployment target lives under `evals/deploy/http-gateway/`: Caddy -> Node gateway -> LiteLLM -> provider APIs, with PostgreSQL on the private Compose network. These files configure a target but do not provision a VM, fund accounts, change DNS, or write secrets.

Credentialed validation is intentionally outside public CI. `evals/smoke/http-gateway-smoke.ts` requires `LIVE_SMOKE=1`, uses reviewed protocol transcript digests, writes only sanitized ignored evidence, and validates auth, route/model policy, streaming, timeouts, metering/reconciliation, token parity, distinct attempts, crash/rerun accounting, reservation refusal, and spend-cap behavior.

No live smoke result is implied by the presence of the runner. A Phase 0 gate may use it only after the operator has provisioned the reviewed host, supplied host-only secrets, funded the two provider accounts with the agreed prepaid limits/auto-reload off, and completed the separate harness licence/terms check required by the PRD.

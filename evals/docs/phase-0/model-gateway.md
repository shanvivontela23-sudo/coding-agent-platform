# P0-04 Model Gateway

Phase 0 owns a small model gateway boundary so harnesses never talk to model providers directly. LiteLLM is the first upstream adapter; it is replaceable behind our `ModelGateway` and `ModelProviderAdapter` interfaces.

## Version pin

The Phase 0 LiteLLM proxy is pinned exactly in `evals/litellm/requirements.txt`:

```text
litellm[proxy]==1.103.2
```

Do not use an unpinned `latest` image or package for benchmark gate runs. A LiteLLM upgrade is an experiment change and must rerun the relevant evals.

## Trust and credential boundary

```text
sandbox / harness
      |
      | short-lived run token only
      v
our ModelGateway
      |
      | hidden run-scoped LiteLLM virtual key
      v
LiteLLM proxy
      |
      | provider credentials from LiteLLM process environment only
      v
model provider
```

Provider API keys are not accepted by the `ModelGateway` call contract. They are not inserted into prompts, cost rows, logs, benchmark manifests, sandbox environment variables, or this repository. Provider credentials belong only to the LiteLLM process environment.

The sandbox receives only a signed token minted by `RunTokenService`. The token contains a run id and expiry and is valid only while that run remains active. The signing secret remains in the control-plane/gateway environment (`MODEL_GATEWAY_RUN_TOKEN_SECRET`) and is never sent to the sandbox.

The LiteLLM admin credential (`LITELLM_GATEWAY_TOKEN`) also remains gateway-side. At run start, `LiteLLMAdapter` uses it to create a temporary LiteLLM virtual key with the same run lifetime and spend cap. Only our gateway stores that upstream virtual key; the sandbox never sees it.

## Per-run spend cap

The default Phase 0 run cap is `$10`, inherited from `runLimits.spendCapUsd`.

Two layers enforce it:

1. `PersistentModelGateway` rejects a call before inference when an adapter can provide a conservative maximum-cost estimate that would push the run over its cap.
2. The LiteLLM adapter creates a run-scoped virtual key with `max_budget` equal to the run cap. LiteLLM's database-backed budget reservation is the authoritative pre-provider guard for real LiteLLM calls.

A Phase 0 LiteLLM deployment therefore **must use its database-backed virtual-key/budget path**. A database-less LiteLLM proxy is not acceptable for gate runs because its budget configuration is not a hard per-run boundary.

When either layer reports a spend limit, the gateway records the run status as `limit-hit` and refuses new paid calls for that run.

## Idempotency and crash recovery

Every inference request has a non-empty `(runId, idempotencyKey)` pair.

Before calling the adapter, the gateway checks its durable store. If a completed call already exists for that pair, the stored response and original cost record are returned with `replayed: true`; the upstream adapter is not called.

For a new paid call, the gateway stores the provider response and its cost record together in one durable call record **before returning the response to the caller**. The file-backed Phase 0 store writes to a private temporary file and atomically links it into place, so a completed idempotency key never becomes visible with a partial response.

This is the checkpoint boundary for the task runner: the caller marks its own task step complete only after `ModelGateway.call()` returns. If the caller crashes after the model response was persisted but before the task step is committed, retrying the same idempotency key returns the stored response without a second provider call.

## Cost records

Each unique paid call produces exactly one `CostRecord` with:

- run id and idempotency key;
- provider and model;
- frozen model settings;
- input tokens;
- cached input tokens;
- output tokens;
- reasoning tokens;
- latency;
- list-price model cost in USD.

The LiteLLM adapter reads list-price cost from the `x-litellm-response-cost` response header and normalizes token usage from the provider-compatible response body. Replays reuse the existing row and add no cost.

`ModelGateway.getRunCostSummary()` aggregates these rows into the same token and `modelCostUsd` fields consumed by the Phase 0 result row. Sandbox seconds/cost are added later by the collector.

Neither prompts nor provider responses are written to a log line by this gateway implementation. The idempotency store contains the response because it is required for safe replay; its root belongs under ignored/private benchmark results, not source control.

## LiteLLM request behavior

The adapter supports the three wire APIs the later harness adapters will need:

- `/v1/chat/completions`
- `/v1/responses`
- `/v1/messages`

This PR does not implement harness runners or model routing. Callers still specify the provider/model/configuration being benchmarked.

The adapter forwards only the run-scoped LiteLLM virtual key in the `Authorization` header. The LiteLLM admin token is used only on the key-management call and is never copied into an inference body. Model-setting names that look like credential fields are rejected.

## CI policy

Unit tests use mocked adapters / mocked `fetch` only. CI must not contain or require an OpenAI, Anthropic, Google, LiteLLM, or other provider credential, and must never make a live model request.

## Later live smoke test

Before Phase 0 gate runs, a credentialed smoke environment must prove all of the following against the pinned LiteLLM version:

1. **Real metering:** one real inference call returns usage and a LiteLLM response cost, and our persisted cost row matches it.
2. **Free replay:** retrying the same idempotency key returns the stored response and does not create a second LiteLLM/provider spend event.
3. **Hard cap:** a run-scoped key at a deliberately tiny budget is rejected before another provider call would exceed that budget, and our run becomes `limit-hit`.
4. **Token scope/expiry:** a token for one run cannot operate on another run and stops authorizing new calls when the run expires or is finished.

The smoke test is intentionally not part of public CI because it requires gateway credentials and incurs real model cost.

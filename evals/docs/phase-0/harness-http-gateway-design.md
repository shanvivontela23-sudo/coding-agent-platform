# P0-05 Harness-Facing HTTP and Streaming Gateway Design

## Purpose

Phase 0 needs a public HTTPS surface that unmodified coding harnesses can use as their normal model-provider base URL. The harness receives only a short-lived run token and never receives provider credentials or the hidden LiteLLM virtual key.

The surface must preserve provider-compatible request/response behavior closely enough that Claude Code, Codex, and later harnesses require no gateway-specific code. It must also meter every paid request, enforce the run's model and spend boundaries, and make streaming spend auditable.

This design is intentionally limited to the harness-facing HTTP surface. Harness runners, model routing, the benchmark collector, hidden-test execution, and product/web code remain out of scope.

## Decisions

### Public contract

One public base URL exposes a strict registry of provider-compatible routes. Initial supported routes are:

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/v1/messages` | Anthropic Messages, streaming and non-streaming |
| POST | `/v1/messages/count_tokens` | Anthropic token counting |
| POST | `/v1/responses` | OpenAI Responses, streaming and non-streaming |
| POST | `/v1/chat/completions` | OpenAI-compatible chat completions, streaming and non-streaming |

There is no catch-all proxy. Every other public path is explicitly refused and recorded as a safe refusal event.

The final Phase 0 route registry is frozen from recorded traffic produced by the exact pinned harness versions used by the benchmark. Public documentation or assumptions do not add routes by themselves.

### Deployment

For Phase 0, the gateway runs on one US cloud VM in a DigitalOcean Basic Droplet class with 2 vCPU and 4 GB RAM. Docker Compose runs:

- Caddy for HTTPS termination;
- the Node harness gateway;
- the pinned LiteLLM proxy;
- PostgreSQL for LiteLLM virtual keys, spend accounting, and budget enforcement.

The VM has a stable public IP. Caddy serves a dedicated HTTPS hostname. Provider credentials, the LiteLLM master credential, the run-token signing secret, and database credentials live only in the host's secret environment. They are never committed to the repository or sent into a sandbox.

The public gateway process does not expose an unauthenticated health endpoint. Operational health checks are bound to loopback or a private administrative path.

### Real-model validation budget

Protocol recording plus live smoke validation has a hard aggregate budget of **$50**:

- OpenAI account hard limit: **$25**;
- Anthropic account hard limit: **$25**.

The existing Phase 0 per-run spend cap remains **$10**. Provider-side hard limits are an additional containment layer, not a replacement for the per-run LiteLLM budget.

## Protocol recorder before route freeze

Before the HTTP surface is considered harness-compatible, each exact benchmark harness version is run against a temporary record-and-forward stub.

The stub must answer requests. It is not a passive logger. For a short controlled session it:

1. authenticates with a dedicated recorder credential;
2. records only safe protocol metadata;
3. strips the recorder credential;
4. forwards the request to the real provider path through the controlled gateway/LiteLLM environment;
5. streams or returns the real response to the harness.

Safe recorded metadata includes:

- harness identity and exact version;
- HTTP method and path;
- non-secret header names, not values;
- content type;
- top-level request field names;
- requested model;
- whether streaming is requested;
- response status and content type.

The recorder never stores authorization header values, provider keys, prompts, tool arguments, model output, or hidden benchmark content.

A session must continue far enough to expose main-model calls, background/small-model calls, token-count traffic, and any other auxiliary endpoints the harness actually uses. The resulting transcript is versioned as a Phase 0 artifact and is the evidence used to freeze the route registry and required headers for that harness version.

## Authentication and run identity

Every public request is authenticated before route handling or body parsing.

Accepted client credential forms are:

- `Authorization: Bearer <run-token>`;
- `x-api-key: <run-token>`.

If both are supplied they must contain the same run token; disagreement is a `401` response. Both incoming credential headers are stripped before forwarding upstream. The upstream LiteLLM virtual key is injected only by the gateway and is never returned to the client.

A harness request does not provide a trusted run id. `RunTokenService` gains a verification method that validates the signature and expiry and returns the signed claims. The gateway derives `runId` only from those claims, then loads the persisted run record and requires it to be active.

Unauthenticated traffic is rejected before body parsing, run lookup, model lookup, LiteLLM access, or refusal logging that would require run context.

## Run model allowlist

`startRun()` persists an exact `allowedModels` set for that benchmark configuration.

The set contains every model the pinned harness is allowed to call during that run, including:

- the primary coding model;
- any explicitly required small/background model discovered by protocol recording.

Every paid call from every supported route is checked against this set and metered against the same run. Matching is exact; arbitrary aliases, prefixes, or provider-wide wildcards are not accepted.

A request for a model outside the run allowlist is refused before upstream work and recorded as a safe authenticated refusal.

## Internet-facing controls

The public endpoint is treated as hostile internet-facing infrastructure.

Per-run-token defaults are:

- maximum request body: **8 MiB**;
- sustained request rate: **120 requests/minute**;
- burst allowance: **20 requests**.

Authentication and rate limiting happen before the body is read. Body-size enforcement happens while reading the request so oversized bodies are terminated without full buffering.

Rate and body limits are configuration values, but the Phase 0 gate configuration freezes their values. A protocol-recording session may demonstrate that a higher limit is required; if so, the value is changed before the gate run and then frozen.

## Strict route registry and refusals

The HTTP server maintains an explicit route registry. A route entry defines:

- method and path;
- wire API;
- whether streaming is allowed;
- how the model field is read;
- how usage is parsed;
- whether the call is paid or zero-cost;
- which request headers may be forwarded.

Unknown routes are never proxied automatically.

For an authenticated refusal, the gateway records only safe fields:

- run id;
- timestamp;
- method;
- normalized path;
- refusal reason.

No credential values, prompts, request bodies, or provider responses are written to refusal logs.

Token-count requests are supported explicitly. Each token-count request receives a normal server-generated call id and a zero-cost call record so the per-run call log is complete. Its `listPriceCostUsd` is `0` and it does not create a paid-spend expectation during reconciliation.

## Call identity and idempotency boundary

Harness-facing HTTP requests are **not idempotent** at our gateway.

Each accepted request receives a fresh server-generated call id. Incoming `Idempotency-Key` headers are removed before upstream forwarding and are not used to replay a previous harness response.

The idempotent storage semantics from P0-04 apply only to direct control-plane `ModelGateway.call()` operations.

If a harness process crashes, the benchmark reruns that harness attempt. Any spend produced by the failed attempt remains part of the measured configuration cost and continues to count against the applicable budget. A rerun does not erase or replay the failed attempt for free.

## Non-streaming data flow

For a normal non-streaming model call:

1. Caddy terminates TLS and forwards to the Node gateway.
2. The gateway authenticates the run token and obtains `runId` from signed claims.
3. The gateway enforces run status, rate limit, request size, route registry, and exact model allowlist.
4. The gateway generates a call id and injects safe correlation metadata for LiteLLM.
5. Incoming client credentials and idempotency headers are stripped.
6. The gateway forwards the request using the hidden run-scoped LiteLLM virtual key.
7. The response body is returned in provider-compatible form.
8. Usage is normalized using the P0-04 token semantics.
9. The gateway persists the call record and later reconciles its authoritative cost against LiteLLM spend data.

## Streaming data flow

Streaming responses are passed through incrementally. The gateway must not wait for the full model response before forwarding bytes to the harness.

For an accepted stream:

1. the request passes the same auth, run, route, rate, size, and model checks as a non-stream request;
2. a fresh call id is generated and included in LiteLLM spend metadata;
3. the upstream response body is read chunk by chunk;
4. each chunk is forwarded to the harness immediately after minimal framing/parser work;
5. an incremental SSE parser observes events in parallel and extracts usage from terminal/final usage events;
6. the stream completion or interruption state is persisted;
7. authoritative monetary cost is resolved from LiteLLM spend records during reconciliation.

The streaming path does not depend on the synchronous `x-litellm-response-cost` header. If that header is present it may be recorded as diagnostic data, but reconciliation against LiteLLM's persisted spend is authoritative.

For OpenAI-compatible Chat Completions, the gateway may add the provider-supported usage-in-stream option when necessary for complete metering, provided the recorded harness transcript and compatibility tests show that this does not alter client behavior.

If the client disconnects, the gateway attempts to cancel upstream work to limit additional spend. The call remains recorded as interrupted. LiteLLM spend is still reconciled; any provider spend incurred before cancellation counts.

## Usage and call records

Harness calls use a separate durable call-log record rather than pretending they have P0-04 control-plane replay semantics.

Each record contains at least:

- run id;
- server-generated call id;
- route/wire API;
- provider/model;
- frozen model settings relevant to the run;
- state: accepted, streaming, completed, interrupted, refused, or reconciliation-failed;
- normalized input, cache-read input, cache-write input, output, and reasoning tokens when available;
- latency;
- LiteLLM correlation id or metadata correlation key;
- authoritative list-price cost when reconciled;
- timestamps.

Prompt bodies and model outputs are not part of the call log.

## Spend reconciliation

LiteLLM spend persistence is asynchronous, so run finalization never assumes spend rows are immediately visible.

At `finishRun()` the reconciler polls LiteLLM with bounded retry:

- initial delay: 500 ms;
- exponential backoff capped at 2 seconds;
- total reconciliation timeout: 30 seconds.

The reconciler waits for every expected paid call id/correlation key to appear or until the timeout expires.

After LiteLLM has caught up, the gateway compares:

- the set of paid calls known to our harness call log;
- LiteLLM spend records for that run-scoped virtual key;
- per-call normalized usage where LiteLLM exposes matching usage;
- the summed authoritative list-price spend.

Zero-cost token-count records remain in our call log but are excluded from the expected paid-spend set.

A missing paid spend record, unexpected extra paid spend record, or monetary mismatch outside a documented rounding tolerance marks reconciliation as failed. A run is not marked invalid merely because LiteLLM had not written its batch yet; only the bounded reconciliation timeout or a post-catch-up mismatch can fail reconciliation.

For interrupted streams where final usage could not be observed from the client-facing stream, LiteLLM's persisted spend/usage record is the fallback accounting source. The interruption remains visible in our call record.

## Error behavior

The public surface returns provider-compatible errors where practical but never exposes internal credentials or upstream secrets.

Important classes are:

- `401`: missing, invalid, conflicting, or expired run credential;
- `404`/explicit unsupported-route response: authenticated request to an unregistered path;
- `413`: request body exceeds the run limit;
- `429`: per-run request rate limit or run spend cap reached;
- `400`: model not in the run's exact allowlist or malformed provider request;
- `502/503`: upstream LiteLLM/provider failure with sanitized detail.

A reconciliation failure is a run-finalization error, not an HTTP-stream rewrite after bytes have already been sent to the harness.

## Live smoke and end-to-end requirements

Public CI uses mocked upstreams only and contains no model-provider keys.

Before Phase 0 gate runs, the real host must be provisioned and the smoke environment must install LiteLLM from the committed hash-locked file using a real install command:

```text
python -m pip install --require-hashes -r evals/litellm/requirements.txt
```

The live validation must prove:

1. the exact pinned Claude Code and Codex binaries can use the public base URL with no custom request translation;
2. recorded transcripts identify every route/header shape needed by those pinned versions;
3. `Authorization: Bearer` and `x-api-key` authentication both work and credentials never reach LiteLLM as client-supplied secrets;
4. run id comes only from signed token claims;
5. primary and background/small-model calls are both allowlisted and metered;
6. unknown routes are refused and appear in the safe refusal log;
7. streaming events reach the harness incrementally rather than after buffering;
8. final stream usage is parsed and normalized correctly;
9. token-count calls create zero-cost call records;
10. reconciliation waits for delayed LiteLLM spend persistence and then matches authoritative spend;
11. an intentional reconciliation mismatch fails loudly;
12. repeated harness HTTP requests produce distinct paid call ids rather than idempotent replay;
13. a crashed harness attempt is rerun and the earlier spend remains counted;
14. the per-run spend cap still stops further paid work;
15. unauthenticated requests are rejected before body work;
16. request-size and per-run rate limits are enforced;
17. the sandbox can reach only the HTTPS gateway during coding/testing;
18. the E2B negative-network smoke checks still block a non-allowlisted hostname, a raw IPv4 address, an outside DNS name, and IPv6 egress.

## Operational prerequisites owned outside the repository

Before record-and-forward or live smoke testing can run, the operator must provision:

1. the DigitalOcean VM and HTTPS hostname;
2. OpenAI and Anthropic API accounts;
3. provider-side hard spend limits of $25 each;
4. provider API keys stored only in the host's secret environment;
5. a random LiteLLM master credential and model-gateway signing secret stored only on the host;
6. PostgreSQL credentials stored only on the host.

No secret value is pasted into chat, committed to Git, baked into a Docker image, or placed in a sandbox environment.

## Test strategy

Unit/integration tests with mocked HTTP/LiteLLM cover:

- bearer auth;
- `x-api-key` auth;
- matching and conflicting dual-auth headers;
- deriving run id from verified token claims;
- expired/finished run rejection;
- exact model allowlists including a background model;
- credential and incoming idempotency-header stripping;
- unknown-route safe refusals;
- zero-cost token-count records;
- body-size limit before full buffering;
- rate limiting per run token;
- unbuffered streaming pass-through;
- OpenAI Responses usage extraction;
- Anthropic Messages usage extraction;
- Chat Completions usage extraction when enabled;
- distinct call ids for repeated identical harness requests;
- client disconnect/interrupted-call accounting;
- bounded delayed reconciliation success;
- reconciliation timeout;
- missing, extra, and mismatched LiteLLM spend failures;
- no prompt/output/credential data in call/refusal logs.

Credentialed provider calls remain outside public CI.

## Out of scope

This slice does not implement:

- harness runners themselves;
- benchmark result collection or hidden-test replay;
- model routing or automatic model selection;
- GitHub PR creation;
- customer-facing web/product code;
- production multi-region/high-availability gateway infrastructure.

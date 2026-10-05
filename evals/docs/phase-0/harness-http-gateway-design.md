# P0-05 Harness-Facing HTTP and Streaming Gateway Design

## Purpose

Phase 0 needs a public HTTPS surface that unmodified coding harnesses can use as their normal model-provider base URL. The harness receives only a short-lived run token and never receives provider credentials or the hidden LiteLLM virtual key.

The surface must preserve provider-compatible request/response behavior closely enough that Claude Code, Codex, and later harnesses require no gateway-specific code. It must also meter every paid request, enforce the run's model and spend boundaries, and make streaming spend auditable.

This design is intentionally limited to the harness-facing HTTP surface. Harness runners, model routing, the benchmark collector, hidden-test execution, and product/web code remain out of scope.

## Decisions

### Public contract

One public base URL exposes a strict registry of provider-compatible routes. The implementation contains handlers for the following routes, but the **frozen Phase 0 route registry enables only routes justified by recorded harness traffic**:

| Method | Path | Purpose | Frozen Phase 0 status |
| --- | --- | --- | --- |
| POST | `/v1/messages` | Anthropic Messages, streaming and non-streaming | enabled when confirmed by the recorded harness transcript |
| POST | `/v1/messages/count_tokens` | Anthropic token counting | enabled when confirmed by the recorded harness transcript |
| POST | `/v1/responses` | OpenAI Responses, streaming and non-streaming | enabled when confirmed by the recorded harness transcript |
| POST | `/v1/chat/completions` | OpenAI-compatible chat completions, streaming and non-streaming | **implemented but disabled** unless a recorded benchmark-harness transcript proves it is required |

There is no catch-all proxy. Every other public path, and every implemented route that is disabled in the frozen route registry, is explicitly refused with `404` after successful run-token authentication and is recorded as a safe refusal event.

The final Phase 0 route registry is frozen from recorded traffic produced by the exact pinned harness versions used by the benchmark. Public documentation or assumptions do not add routes by themselves. Enabling `/v1/chat/completions` is therefore an evidence-backed configuration change, not an automatic consequence of the handler existing in code.

### Deployment

For Phase 0, the gateway runs on one US cloud VM in a DigitalOcean Basic Droplet class with 2 vCPU and 4 GB RAM. Docker Compose runs:

- Caddy for HTTPS termination;
- the Node harness gateway;
- the pinned LiteLLM proxy;
- PostgreSQL for LiteLLM virtual keys, spend accounting, and budget enforcement.

The VM has a stable public IP. Caddy serves a dedicated HTTPS hostname. Provider credentials, the LiteLLM master credential, the run-token signing secret, and database credentials live only in the host's secret environment. They are never committed to the repository or sent into a sandbox.

Caddy must preserve streaming semantics. Its reverse-proxy configuration must not buffer model response bodies before forwarding them to the Node gateway/client. The live smoke test must demonstrate that multiple upstream SSE events reach the harness incrementally rather than arriving in one buffered flush.

The public gateway process does not expose an unauthenticated health endpoint. Operational health checks are bound to loopback or a private administrative path.

### Real-model validation budget

Protocol recording plus live smoke validation has a hard aggregate budget of **$50**:

- OpenAI: fund **$25 of prepaid credits** and keep automatic reload disabled;
- Anthropic: fund **$25 of prepaid credits** and keep automatic reload disabled.

No postpaid or auto-reloading balance is used for the Phase 0 record-and-forward/smoke environment. If either provider account cannot be constrained to an equivalent pre-funded hard maximum, live validation does not start until an equivalent hard containment mechanism is configured.

The existing Phase 0 per-run spend cap remains **$10**. Prepaid provider limits are an additional containment layer, not a replacement for the per-run LiteLLM budget.

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

## Internet-facing controls and timeouts

The public endpoint is treated as hostile internet-facing infrastructure.

Per-run-token defaults are:

- maximum request body: **8 MiB**;
- sustained request rate: **120 requests/minute**;
- burst allowance: **20 requests**;
- non-streaming upstream request timeout: **10 minutes** total from upstream dispatch to complete response;
- streaming first-response timeout: **120 seconds** from upstream dispatch to receipt of response headers/first stream bytes;
- streaming idle timeout: **90 seconds** without an upstream response chunk/event;
- maximum streaming duration: **20 minutes** from upstream dispatch to stream termination.

Authentication and rate limiting happen before the body is read. Body-size enforcement happens while reading the request so oversized bodies are terminated without full buffering.

Timeout expiry cancels the upstream request where possible and records the harness call as interrupted/timeout. Any LiteLLM/provider spend already incurred still counts and must reconcile normally. Caddy and Node server/proxy timeout configuration must not be shorter than these application-level limits and must not buffer streaming responses.

Rate, body, and timeout limits are configuration values, but the Phase 0 gate configuration freezes their values. A protocol-recording session may demonstrate that a higher limit is required; if so, the value is changed before the gate run and then frozen.

## Strict route registry and refusals

The HTTP server maintains an explicit route registry. A route entry defines:

- method and path;
- whether the route is enabled in the frozen benchmark configuration;
- wire API;
- whether streaming is allowed;
- how the model field is read;
- how usage is parsed;
- whether the call is paid or zero-cost;
- which request headers may be forwarded.

Unknown routes and disabled routes are never proxied automatically. An authenticated unknown or disabled route returns `404` with a sanitized JSON error body and creates one refusal record.

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

1. Caddy terminates TLS and forwards to the Node gateway without response buffering.
2. The gateway authenticates the run token and obtains `runId` from signed claims.
3. The gateway enforces run status, rate limit, request size, route registry, and exact model allowlist.
4. The gateway generates a call id and injects safe correlation metadata for LiteLLM.
5. Incoming client credentials and idempotency headers are stripped.
6. The gateway forwards the request using the hidden run-scoped LiteLLM virtual key with the configured upstream timeout.
7. The response body is returned in provider-compatible form.
8. Usage is normalized using the P0-04 token semantics.
9. The gateway persists the call record and later reconciles its authoritative cost against LiteLLM spend data.

## Streaming data flow

Streaming responses are passed through incrementally. The gateway must not wait for the full model response before forwarding bytes to the harness, and Caddy must not buffer those bytes.

For an accepted stream:

1. the request passes the same auth, run, route, rate, size, and model checks as a non-stream request;
2. a fresh call id is generated and included in LiteLLM spend metadata;
3. the gateway enforces the 120-second first-response timeout, 90-second idle timeout, and 20-minute maximum stream duration;
4. the upstream response body is read chunk by chunk;
5. each chunk is forwarded through Caddy to the harness immediately after minimal framing/parser work;
6. an incremental SSE parser observes events in parallel and extracts usage from terminal/final usage events;
7. the stream completion, timeout, or interruption state is persisted;
8. authoritative monetary cost is resolved from LiteLLM spend records during reconciliation.

The streaming path does not depend on the synchronous `x-litellm-response-cost` header. If that header is present it may be recorded as diagnostic data, but reconciliation against LiteLLM's persisted spend is authoritative.

The `/v1/chat/completions` streaming implementation exists but is disabled in the frozen route registry until a recorded harness transcript proves a benchmark harness needs it. If it is later enabled, the gateway may add the provider-supported usage-in-stream option when necessary for complete metering, provided the recorded harness transcript and compatibility tests show that this does not alter client behavior.

If the client disconnects or any stream timeout fires, the gateway attempts to cancel upstream work to limit additional spend. The call remains recorded as interrupted/timeout. LiteLLM spend is still reconciled; any provider spend incurred before cancellation counts.

## Usage and call records

Harness calls use a separate durable call-log record rather than pretending they have P0-04 control-plane replay semantics.

Each record contains at least:

- run id;
- server-generated call id;
- route/wire API;
- provider/model;
- frozen model settings relevant to the run;
- state: accepted, streaming, completed, interrupted, timeout, refused, or reconciliation-failed;
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

A missing paid spend record, unexpected extra paid spend record, or absolute monetary difference greater than **$0.000001** marks reconciliation as failed. Integer token counts must match exactly when both sides expose the same counter. A run is not marked invalid merely because LiteLLM had not written its batch yet; only the bounded reconciliation timeout or a post-catch-up mismatch can fail reconciliation.

For interrupted or timed-out streams where final usage could not be observed from the client-facing stream, LiteLLM's persisted spend/usage record is the fallback accounting source. The interruption/timeout remains visible in our call record.

## Error behavior

The public surface returns provider-compatible errors where practical but never exposes internal credentials or upstream secrets.

Important classes are:

- `401`: missing, invalid, conflicting, or expired run credential;
- `404`: authenticated request to an unregistered or disabled path, with a sanitized JSON error body;
- `408/504`: request/stream timeout according to whether the timeout occurred before or after upstream dispatch;
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
3. `/v1/chat/completions` stays refused while disabled and is enabled only if a recorded harness transcript demonstrates a benchmark requirement;
4. `Authorization: Bearer` and `x-api-key` authentication both work and credentials never reach LiteLLM as client-supplied secrets;
5. run id comes only from signed token claims;
6. primary and background/small-model calls are both allowlisted and metered;
7. unknown and disabled routes are refused and appear in the safe refusal log;
8. Caddy does not buffer model streams and multiple SSE events reach the harness incrementally;
9. final stream usage is parsed and normalized correctly;
10. the upstream first-response timeout, stream idle timeout, maximum stream duration, and non-streaming upstream timeout terminate work and record timeout state correctly;
11. token-count calls create zero-cost call records;
12. reconciliation waits for delayed LiteLLM spend persistence and then matches authoritative spend;
13. an intentional reconciliation mismatch fails loudly;
14. repeated harness HTTP requests produce distinct paid call ids rather than idempotent replay;
15. a crashed harness attempt is rerun and the earlier spend remains counted;
16. the per-run spend cap still stops further paid work;
17. unauthenticated requests are rejected before body work;
18. request-size and per-run rate limits are enforced;
19. the sandbox can reach only the HTTPS gateway during coding/testing;
20. the E2B negative-network smoke checks still block a non-allowlisted hostname, a raw IPv4 address, an outside DNS name, and IPv6 egress.

## Operational prerequisites owned outside the repository

Before record-and-forward or live smoke testing can run, the operator must provision:

1. the DigitalOcean VM and HTTPS hostname;
2. an OpenAI API account funded with **$25 prepaid credits**, with automatic reload disabled;
3. an Anthropic API account funded with **$25 prepaid credits**, with automatic reload disabled;
4. provider API keys stored only in the host's secret environment;
5. an E2B account and E2B API key, with the key stored only in the trusted control-plane/smoke-runner secret environment and never inside the sandbox guest;
6. a random LiteLLM master credential and model-gateway signing secret stored only on the host;
7. PostgreSQL credentials stored only on the host.

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
- implemented-but-disabled `/v1/chat/completions` refusal and evidence-backed enablement;
- zero-cost token-count records;
- body-size limit before full buffering;
- rate limiting per run token;
- Caddy/Node streaming configuration contract with no proxy buffering;
- unbuffered streaming pass-through;
- streaming first-response timeout;
- streaming idle timeout;
- maximum stream duration;
- non-streaming upstream timeout;
- OpenAI Responses usage extraction;
- Anthropic Messages usage extraction;
- Chat Completions usage extraction when enabled;
- distinct call ids for repeated identical harness requests;
- client disconnect/interrupted-call accounting;
- timeout accounting;
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

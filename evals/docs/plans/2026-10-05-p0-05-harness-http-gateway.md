# P0-05 Harness-Facing HTTP and Streaming Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Phase 0 internet-facing provider-compatible HTTP gateway that unmodified coding harnesses can use with a short-lived run token, with strict route/model controls, unbuffered streaming, complete metering, and LiteLLM spend reconciliation.

**Architecture:** Extend the existing P0-04 gateway only where the HTTP surface needs shared run state: token claim verification, exact per-run model allowlists, and access to the run-scoped LiteLLM virtual key. Implement the public surface as a native Node 22 HTTP server under `evals/src/gateway/http/`, with explicit route specs, a separate harness-call store, a direct LiteLLM transport for provider-compatible pass-through, and a bounded reconciliation client. Keep control-plane idempotent calls and harness HTTP calls separate: the former continue to replay safely; the latter always receive a fresh server-generated call ID and all spend counts.

**Tech Stack:** TypeScript 5.9 strict mode, Node.js >=22 native `node:http`/WHATWG streams/fetch, Vitest 3, existing P0-04 `RunTokenService`/`GatewayStore`/LiteLLM virtual-key flow, LiteLLM `1.103.2` from the committed `--require-hashes` lock, Caddy, PostgreSQL, Docker Compose, E2B for credentialed smoke only.

**Spec:** `evals/docs/phase-0/harness-http-gateway-design.md`

## Global Constraints

- Keep Phase 0 code under `evals/`; no web/product code in this slice.
- Use native Node HTTP primitives; add no Node runtime dependency unless a later review explicitly approves it.
- `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, and `pnpm test` must remain green.
- Provider credentials, LiteLLM master credentials, run-token signing secrets, PostgreSQL passwords, and the E2B API key never enter the sandbox, prompt, log, committed file, or chat.
- Public authentication accepts `Authorization: Bearer <run-token>` and `x-api-key: <run-token>`; if both exist they must match.
- Derive `runId` only from verified signed claims. Do not trust a run id supplied by a harness body/header/query.
- Reject unauthenticated traffic before body parsing or other work.
- Persist an exact non-empty `allowedModels` set at `startRun()`; every main/background paid model call must match it exactly.
- Enabled frozen routes: `POST /v1/messages`, `POST /v1/messages/count_tokens`, `POST /v1/responses`.
- Implement `POST /v1/chat/completions`, but keep it disabled in the frozen route config until a recorded benchmark-harness transcript proves it is needed.
- Authenticated unknown or disabled routes return sanitized `404` and create a safe refusal record.
- Token-count calls create normal call records with `listPriceCostUsd: 0` and are excluded from expected paid-spend reconciliation.
- Harness HTTP calls are not idempotent: strip incoming `Idempotency-Key`, generate a fresh server call ID, and count prior spend if a harness attempt crashes and is rerun.
- Maximum request body: 8 MiB. Sustained per-run rate: 120 requests/minute. Burst: 20.
- Non-streaming upstream timeout: 10 minutes. Streaming first-response timeout: 120 seconds. Streaming idle timeout: 90 seconds. Maximum stream duration: 20 minutes.
- Caddy must not buffer SSE. Preserve client-disconnect propagation so Node can attempt upstream cancellation; prove incremental delivery in live smoke rather than relying only on config inspection.
- Default per-run model spend cap remains $10.
- Reconciliation polling: 500 ms initial delay, exponential backoff capped at 2 seconds, 30-second total timeout.
- Reconciliation monetary tolerance: absolute difference <= $0.000001; matching integer token counters must match exactly when both sides expose them.
- Real validation budget: $25 prepaid OpenAI + $25 prepaid Anthropic, automatic reload disabled; do not start live validation without equivalent hard containment.
- Live LiteLLM installation must use `python -m pip install --require-hashes -r evals/litellm/requirements.txt`.
- Public CI uses mocks only: no live provider, LiteLLM, E2B, or paid calls.

## Review Focus

1. **Auth-before-body on hostile input:** a malformed/huge chunked body with missing or conflicting credentials must be rejected without consuming the body; covered in Task 4 HTTP-handler tests.
2. **SSE framing split across arbitrary TCP chunks:** event lines and terminal usage payloads may cross chunk boundaries; covered in Task 6 stream-parser tests.
3. **Client disconnect or timeout after provider spend begins:** upstream cancellation is attempted, the call stays interrupted/timeout, and reconciliation still counts spend; covered in Tasks 6 and 7.
4. **Model-name confusion:** primary/background models are exact allowlist entries; aliases, prefixes, and a valid model from another run are refused; covered in Tasks 1 and 4.
5. **Delayed/duplicate/unexpected LiteLLM spend rows:** reconciliation waits for asynchronous persistence but fails on missing, extra, duplicated correlation IDs, or cost/token mismatch after catch-up; covered in Task 7.

---

### Task 1: Bind run claims and allowed models to persisted run state

**Files:**
- Modify: `evals/src/gateway/types.ts`
- Modify: `evals/src/gateway/run-token.ts`
- Modify: `evals/src/gateway/model-gateway.ts`
- Modify: `evals/tests/model-gateway.test.ts`
- Modify: `evals/tests/model-gateway-hardening.test.ts`

**Interfaces:**
- Consumes: existing `RunTokenService`, `PersistentModelGateway`, `GatewayStore`.
- Produces: `RunTokenService.verifyClaims(token: string): RunTokenClaims`; `GatewayRunRecord.allowedModels: readonly string[]`; `StartRunRequest.allowedModels: readonly string[]`.

- [ ] **Step 1: Write failing token-claim tests**

Add tests asserting `verifyClaims(token)` returns the signed `runId`/expiry without caller-supplied run identity, rejects tampering/expiry, and existing `verify(token, expectedRunId)` still rejects cross-run use.

- [ ] **Step 2: Run the focused token/gateway tests and confirm RED**

Run: `pnpm exec vitest run evals/tests/model-gateway.test.ts evals/tests/model-gateway-hardening.test.ts`

Expected: FAIL because `verifyClaims` and `allowedModels` do not exist.

- [ ] **Step 3: Implement claim verification without changing token format**

In `run-token.ts`, extract signature/shape/expiry validation into:

```ts
verifyClaims(token: string): RunTokenClaims
```

Keep:

```ts
verify(token: string, expectedRunId: string): RunTokenClaims
```

as a wrapper around `verifyClaims()` plus exact run-id comparison.

- [ ] **Step 4: Add exact model allowlist to run contracts**

Change:

```ts
type StartRunRequest = {
  runId: string;
  expiresAtMs: number;
  spendCapUsd?: number;
  allowedModels: readonly string[];
};

type GatewayRunRecord = {
  // existing fields
  allowedModels: readonly string[];
};
```

`PersistentModelGateway.startRun()` must trim entries, reject an empty set/empty model name/duplicate after normalization, preserve exact case-sensitive model strings, and persist the frozen array. It must pass no provider key/model allowlist into the issued run token.

- [ ] **Step 5: Add cross-run/background-model regression tests**

Assert one run can allow `primary-model` + `background-model`, a second run can have a different set, and the stored run records never bleed allowlists across run IDs.

- [ ] **Step 6: Run focused tests to GREEN**

Run the Task 1 test command again. Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add evals/src/gateway/types.ts evals/src/gateway/run-token.ts evals/src/gateway/model-gateway.ts evals/tests/model-gateway*.test.ts
git commit -m "feat(gateway): bind HTTP runs to token claims and model allowlists"
```

---

### Task 2: Freeze the route/limit configuration and safe route metadata

**Files:**
- Create: `evals/config/http-gateway.json`
- Create: `evals/src/gateway/http/types.ts`
- Create: `evals/src/gateway/http/config.ts`
- Create: `evals/src/gateway/http/route-registry.ts`
- Test: `evals/tests/http-route-registry.test.ts`

**Interfaces:**
- Consumes: `ModelWireApi`, approved P0-05 constants.
- Produces: `HarnessHttpConfig`, `HarnessRouteSpec`, `loadHarnessHttpConfig()`, `getHarnessRoute(method, path, config)`.

- [ ] **Step 1: Write failing frozen-route/config tests**

Tests must pin these exact values:

```ts
maxBodyBytes = 8 * 1024 * 1024
ratePerMinute = 120
rateBurst = 20
nonStreamingTimeoutMs = 600_000
firstResponseTimeoutMs = 120_000
streamIdleTimeoutMs = 90_000
maxStreamDurationMs = 1_200_000
reconciliationTimeoutMs = 30_000
reconciliationInitialDelayMs = 500
reconciliationMaxDelayMs = 2_000
costToleranceUsd = 0.000001
```

Assert Messages, Messages token-count, and Responses resolve as enabled; Chat Completions resolves as implemented-but-disabled; unknown methods/paths resolve to no route.

- [ ] **Step 2: Run the new route-registry test and confirm RED**

Run: `pnpm exec vitest run evals/tests/http-route-registry.test.ts`

- [ ] **Step 3: Implement route specs and frozen JSON config**

Each `HarnessRouteSpec` must define exact method/path, `wireApi`, `enabled`, `streamingAllowed`, `paid`, `modelField`, safe forwarded header names, and safe model-setting field names. Do not use wildcard routes.

- [ ] **Step 4: Add a test that Chat Completions cannot be enabled without evidence metadata**

If `enabledRoutes` includes `/v1/chat/completions`, config validation requires a non-empty `routeEvidence.chatCompletionsTranscriptSha256` matching 64 hex characters. The default committed config keeps it disabled and has no evidence hash.

- [ ] **Step 5: Run focused tests to GREEN**

- [ ] **Step 6: Commit**

```bash
git add evals/config/http-gateway.json evals/src/gateway/http evals/tests/http-route-registry.test.ts
git commit -m "feat(gateway): freeze provider-compatible HTTP route policy"
```

---

### Task 3: Add durable harness-call and refusal storage separate from control-plane replay

**Files:**
- Create: `evals/src/gateway/http/store.ts`
- Create: `evals/src/gateway/http/file-store.ts`
- Test: `evals/tests/http-call-store.test.ts`

**Interfaces:**
- Consumes: `ModelUsage`.
- Produces:

```ts
interface HarnessCallStore {
  createCall(record: HarnessCallRecord): Promise<void>;
  saveCall(record: HarnessCallRecord): Promise<void>;
  getCall(runId: string, callId: string): Promise<HarnessCallRecord>;
  listCalls(runId: string): Promise<readonly HarnessCallRecord[]>;
  appendRefusal(record: HarnessRefusalRecord): Promise<void>;
  listRefusals(runId: string): Promise<readonly HarnessRefusalRecord[]>;
}
```

`HarnessCallRecord` carries `runId`, fresh `callId`, route/wire API, provider/model, safe model settings, paid/zero-cost flag, lifecycle state, normalized usage, latency, LiteLLM correlation ID, reconciled cost, and timestamps. It never contains prompt/request body/model output/credential values.

- [ ] **Step 1: Write failing per-run isolation and secret-exclusion tests**

Create two runs and prove listing calls/refusals for run A never parses run B's files. Inspect serialized JSON and assert representative prompt text, `Authorization`, `x-api-key`, LiteLLM virtual key, and provider key strings are absent.

- [ ] **Step 2: Run the store test and confirm RED**

- [ ] **Step 3: Implement `FileHarnessCallStore` using hashed per-run directories and mode `0600` atomic writes**

Use separate roots such as `harness-calls/<run-hash>/` and `harness-refusals/<run-hash>/`; do not reuse the P0-04 idempotency-call files.

- [ ] **Step 4: Add immutable identity checks**

`saveCall()` may update lifecycle/usage/cost fields, but must reject changes to `runId`, `callId`, route, provider, or model for an existing call.

- [ ] **Step 5: Run focused tests to GREEN**

- [ ] **Step 6: Commit**

```bash
git add evals/src/gateway/http/store.ts evals/src/gateway/http/file-store.ts evals/tests/http-call-store.test.ts
git commit -m "feat(gateway): persist non-idempotent harness call logs"
```

---

### Task 4: Implement authentication, rate/body guards, exact model authorization, and safe refusals

**Files:**
- Create: `evals/src/gateway/http/auth.ts`
- Create: `evals/src/gateway/http/rate-limiter.ts`
- Create: `evals/src/gateway/http/request-body.ts`
- Create: `evals/src/gateway/http/handler.ts`
- Test: `evals/tests/http-auth-and-limits.test.ts`

**Interfaces:**
- Consumes: `RunTokenService.verifyClaims()`, `GatewayStore.getRun()`, `HarnessCallStore`, route registry/config.
- Produces: `authenticateHarnessRequest(headers): { token: string; claims: RunTokenClaims }`; `RunTokenBucket`; `readJsonBodyWithinLimit()`; `createHarnessHttpHandler(options)`.

- [ ] **Step 1: Write failing auth matrix tests**

Cover bearer only, `x-api-key` only, matching dual headers, conflicting dual headers, malformed bearer, expired token, finished/limit-hit run, and valid token for another run. Assert the handler derives the run exclusively from claims.

- [ ] **Step 2: Add auth-before-body and oversized chunked-body tests**

Use a request stream that throws if consumed. Missing/conflicting auth must return `401` without reading it. For authenticated input, stream >8 MiB in chunks and assert `413` occurs before full body consumption.

- [ ] **Step 3: Add rate-limit tests**

With injected clock, assert a token bucket starts with burst capacity 20, refills at 2 requests/second (120/min), and returns `429` after exhaustion without upstream work.

- [ ] **Step 4: Add model-allowlist/refusal tests**

For an allowed run containing `primary-model` and `background-model`, both pass. Prefix/alias/case variation and a model allowed only in another run return sanitized `400` and one refusal record. Unknown/disabled routes return authenticated `404` and one refusal record. `/v1/chat/completions` is refused under default config.

- [ ] **Step 5: Run the focused file and confirm RED**

- [ ] **Step 6: Implement guards in strict order**

Handler order must be: parse credential headers without body -> verify claims -> load active run -> rate limit -> route lookup/enabled check -> bounded body read/JSON parse -> exact model allowlist -> call dispatch. Refusal logs contain only run ID, timestamp, method, normalized path, and refusal reason.

- [ ] **Step 7: Run focused tests to GREEN**

- [ ] **Step 8: Commit**

```bash
git add evals/src/gateway/http evals/tests/http-auth-and-limits.test.ts
git commit -m "feat(gateway): enforce public HTTP auth and run limits"
```

---

### Task 5: Add LiteLLM pass-through transport and non-streaming provider-compatible responses

**Files:**
- Create: `evals/src/gateway/http/upstream.ts`
- Create: `evals/src/gateway/usage.ts`
- Modify: `evals/src/gateway/litellm-adapter.ts`
- Modify: `evals/src/gateway/http/handler.ts`
- Test: `evals/tests/http-nonstreaming.test.ts`
- Modify: `evals/tests/model-gateway.test.ts`

**Interfaces:**
- Consumes: authenticated run record including hidden `upstreamCredential`; route spec; `HarnessCallStore`.
- Produces: `LiteLLMHarnessTransport.forward(request, signal): Promise<Response>`; shared `normalizeModelUsage(wireApi, body): ModelUsage` used by both P0-04 and HTTP paths.

- [ ] **Step 1: Extract usage normalization under existing tests**

Move the existing wire-specific usage normalization out of `litellm-adapter.ts` into `usage.ts` without changing P0-04 semantics. Run existing gateway tests and keep them green before adding HTTP behavior.

- [ ] **Step 2: Write failing non-streaming forwarding tests**

Assert incoming `Authorization`, `x-api-key`, and `Idempotency-Key` are stripped; the hidden run virtual key becomes the only upstream `Authorization`; a server-generated call ID is injected as the gateway-controlled LiteLLM correlation header/metadata; safe provider headers such as `anthropic-version`/approved beta headers are preserved only when route policy allows them.

- [ ] **Step 3: Add duplicate-request non-idempotency test**

Send two identical harness requests. Assert two different call IDs, two upstream calls, and two call records. Do not call `ModelGateway.call()` or its idempotency store.

- [ ] **Step 4: Add 10-minute upstream timeout test with an override of a few milliseconds**

The abort signal must fire, the upstream is cancelled, the call state becomes `timeout`, and no fake free replay is created.

- [ ] **Step 5: Implement non-streaming transport/handler path**

Buffer only already-size-bounded accepted JSON. Preserve provider-compatible status/body/content-type. Persist safe call metadata and normalized usage; monetary cost remains pending reconciliation rather than trusting a streaming-only assumption.

- [ ] **Step 6: Implement token-count as zero-cost normal call record**

Forward `/v1/messages/count_tokens`, return provider-compatible body, record usage/count metadata available from the response, set `paid: false` and `listPriceCostUsd: 0`, and exclude it later from paid-spend expectations.

- [ ] **Step 7: Run focused + existing gateway tests to GREEN**

Run: `pnpm exec vitest run evals/tests/http-nonstreaming.test.ts evals/tests/model-gateway.test.ts evals/tests/model-gateway-hardening.test.ts`

- [ ] **Step 8: Commit**

```bash
git add evals/src/gateway evals/tests/http-nonstreaming.test.ts evals/tests/model-gateway*.test.ts
git commit -m "feat(gateway): proxy non-streaming harness model calls"
```

---

### Task 6: Stream SSE without buffering and meter terminal usage

**Files:**
- Create: `evals/src/gateway/http/sse.ts`
- Create: `evals/src/gateway/http/stream-proxy.ts`
- Modify: `evals/src/gateway/http/handler.ts`
- Test: `evals/tests/http-streaming.test.ts`

**Interfaces:**
- Consumes: upstream `Response.body`, route `wireApi`, HTTP response sink, `HarnessCallStore`.
- Produces: `SseEventParser.push(chunk): readonly SseEvent[]`; `proxyMeteredStream(options): Promise<StreamCompletion>`.

- [ ] **Step 1: Write RED tests for arbitrary SSE chunk boundaries**

Feed one valid Anthropic and one OpenAI Responses stream with event names/data split in the middle of UTF-8/text lines and JSON payloads. Assert reconstructed events and final normalized usage are correct.

- [ ] **Step 2: Write RED pass-through timing test**

Use an upstream that yields three chunks under test control. Assert each chunk is written to the client before the next chunk is released; the handler must not concatenate/full-buffer the stream.

- [ ] **Step 3: Write timeout tests**

Using short injected durations, cover: no response/first bytes -> first-response timeout; no chunk after one event -> idle timeout; continuous chunks beyond max duration -> max-duration timeout. Each aborts upstream and persists `timeout`.

- [ ] **Step 4: Write client-disconnect test**

Simulate response socket close after the first chunk. Assert the upstream abort controller is triggered, call state becomes `interrupted`, and the record remains eligible for later spend reconciliation.

- [ ] **Step 5: Implement incremental parser/proxy**

Use `TextDecoder(..., { stream: true })` and carry incomplete SSE lines/events between chunks. Write raw bytes to the harness immediately; parsing is side-band only. Do not rewrite SSE payloads.

- [ ] **Step 6: Parse terminal usage by wire API**

Anthropic Messages and OpenAI Responses must populate the same normalized `ModelUsage` semantics established in P0-04. Implement Chat Completions stream parsing too, but it remains unreachable while its route is disabled.

- [ ] **Step 7: Run focused tests to GREEN**

- [ ] **Step 8: Commit**

```bash
git add evals/src/gateway/http evals/tests/http-streaming.test.ts
git commit -m "feat(gateway): stream and meter provider-compatible SSE"
```

---

### Task 7: Reconcile every paid harness call against delayed LiteLLM spend logs

**Files:**
- Create: `evals/src/gateway/http/litellm-spend.ts`
- Create: `evals/src/gateway/http/reconciler.ts`
- Test: `evals/tests/http-reconciliation.test.ts`

**Interfaces:**
- Consumes: run-scoped LiteLLM virtual key from `GatewayRunRecord`, `HarnessCallStore.listCalls(runId)`, LiteLLM admin credential held only by the trusted gateway process.
- Produces: `LiteLLMSpendClient.listRunSpend(upstreamCredential): Promise<readonly LiteLLMSpendRecord[]>`; `reconcileRunSpend(runId, options): Promise<ReconciliationResult>`.

- [ ] **Step 1: Write delayed-catch-up RED test**

Mock spend lookup returning no rows, then partial rows, then all paid rows. With fake/injected sleep, assert polling schedule starts at 500 ms, doubles up to 2 seconds, and succeeds before the 30-second deadline.

- [ ] **Step 2: Write mismatch RED tests**

Cover missing paid correlation ID after timeout, unexpected extra paid row for the run key, duplicate correlation ID, cost difference >$0.000001, and integer-token mismatch. Each must mark affected call/run reconciliation failed and throw a clear finalization error.

- [ ] **Step 3: Write zero-cost and interrupted-stream tests**

Token-count records must not require a paid spend row. An interrupted/timeout paid call may obtain usage/cost from LiteLLM even when terminal client-side usage is absent, but it still stays visibly interrupted/timeout.

- [ ] **Step 4: Implement LiteLLM spend retrieval using the run virtual key scope**

Use the pinned LiteLLM management API with the admin credential and query spend rows for that run's virtual key. Match rows by the gateway-controlled call ID stored in LiteLLM spend metadata/correlation fields. Never expose either credential to the harness or logs.

- [ ] **Step 5: Implement bounded reconciliation**

Reconcile only after LiteLLM has had the full bounded catch-up window. Update authoritative per-call `listPriceCostUsd` and available usage, then return aggregate paid spend for the run.

- [ ] **Step 6: Run focused tests to GREEN**

- [ ] **Step 7: Commit**

```bash
git add evals/src/gateway/http/litellm-spend.ts evals/src/gateway/http/reconciler.ts evals/tests/http-reconciliation.test.ts
git commit -m "feat(gateway): reconcile harness spend with LiteLLM"
```

---

### Task 8: Add the record-and-forward protocol recorder and route-evidence artifact

**Files:**
- Create: `evals/src/gateway/http/protocol-recorder.ts`
- Create: `evals/src/gateway/http/recorder-cli.ts`
- Create: `evals/src/gateway/http/transcript.ts`
- Test: `evals/tests/protocol-recorder.test.ts`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: dedicated recorder credential, LiteLLM base URL/virtual key, native fetch/streaming.
- Produces: `ProtocolTranscript` containing only harness/version, method/path, non-secret header names, content type, top-level request field names, requested model, stream flag, response status/content type, and SHA-256 digest.

- [ ] **Step 1: Write safe-recording RED tests**

Send a request containing fake auth keys, prompt/messages, tool arguments, and fake model output. Assert transcript includes only allowed metadata and none of the values/content. Header names such as `authorization`/`x-api-key` must be omitted entirely from the recorded header-name set.

- [ ] **Step 2: Write record-and-forward continuation test**

Mock a first main-model call followed by background-model and token-count calls that occur only after valid responses. Assert the recorder forwards/answers all three and captures all route shapes; a passive logger implementation would fail this test.

- [ ] **Step 3: Implement recorder as an explicit non-gate mode**

Require a dedicated recorder secret and explicit `--record-protocol`/separate CLI. It may transparently forward observed provider paths for the controlled recording session, but that behavior must not be reachable from the normal strict gateway server.

- [ ] **Step 4: Write transcript to ignored results storage and emit its SHA-256**

Default output: `evals/results/protocol/`. Add that runtime results path to `.gitignore`. The operator may copy the sanitized artifact into the benchmark evidence store; enabling Chat Completions requires its digest in frozen config.

- [ ] **Step 5: Run focused tests to GREEN**

- [ ] **Step 6: Commit**

```bash
git add evals/src/gateway/http .gitignore evals/tests/protocol-recorder.test.ts
git commit -m "feat(gateway): record and forward harness protocol traffic safely"
```

---

### Task 9: Add the runnable Node gateway service and deployment configuration

**Files:**
- Create: `evals/src/gateway/http/server.ts`
- Create: `evals/src/gateway/http/cli.ts`
- Create: `evals/deploy/http-gateway/Dockerfile.gateway`
- Create: `evals/deploy/http-gateway/Dockerfile.litellm`
- Create: `evals/deploy/http-gateway/compose.yaml`
- Create: `evals/deploy/http-gateway/Caddyfile`
- Create: `evals/deploy/http-gateway/litellm-config.yaml`
- Create: `evals/deploy/http-gateway/README.md`
- Modify: `.env.example`
- Modify: `evals/src/gateway/index.ts`
- Test: `evals/tests/http-server-config.test.ts`

**Interfaces:**
- Consumes: Tasks 1-8 components and environment values.
- Produces: executable gateway service listening only on the container/private HTTP port behind Caddy; loopback/private health check; deployment files with no secret values.

- [ ] **Step 1: Write RED server/config tests**

Assert public server wires strict handler only, has no unauthenticated public health route, and environment parsing rejects missing signing/LiteLLM/store configuration. Assert `.env.example` contains empty placeholders only for gateway/LiteLLM/Postgres/provider/E2B secrets.

- [ ] **Step 2: Add deployment static tests**

Assert Compose has Caddy -> Node -> LiteLLM/Postgres topology, no provider/E2B secrets are passed into any sandbox component, LiteLLM is built from `evals/litellm/requirements.txt` with `pip install --require-hashes`, and no floating `latest` images are allowed. Pin external images by immutable digest when implementation is committed.

- [ ] **Step 3: Implement native HTTP server/CLI**

Expose only the provider-compatible strict handler publicly. Bind operational health to loopback/private container networking. Install SIGTERM/SIGINT shutdown that stops accepting new requests and gives active streams a bounded drain period before abort.

- [ ] **Step 4: Configure Caddy for SSE without breaking disconnect cancellation**

Do not configure response buffering. Preserve `Content-Type: text/event-stream` from Node so Caddy's streaming behavior flushes SSE immediately. Do not choose a low-latency option that intentionally keeps the backend request alive after the client disconnects; the live smoke test is the authority that events arrive incrementally and disconnect cancellation propagates.

- [ ] **Step 5: Add operator README**

Document DigitalOcean 2-vCPU/4-GB Phase 0 target, HTTPS DNS prerequisite, $25 prepaid credits/provider with auto-reload off, E2B account/API key, secret placement on host only, firewall (public 443; SSH restricted; internal service ports not public), and no provisioning until the operator confirms these external accounts.

- [ ] **Step 6: Run focused tests to GREEN**

- [ ] **Step 7: Commit**

```bash
git add evals/src/gateway/http evals/deploy/http-gateway .env.example evals/src/gateway/index.ts evals/tests/http-server-config.test.ts
git commit -m "feat(gateway): package Phase 0 public HTTP gateway"
```

---

### Task 10: Add credentialed smoke runners without putting secrets in CI

**Files:**
- Create: `evals/smoke/http-gateway-smoke.ts`
- Create: `evals/smoke/e2b-network-smoke.ts`
- Create: `evals/smoke/README.md`
- Modify: `package.json`
- Test: `evals/tests/smoke-contract.test.ts`

**Interfaces:**
- Consumes: externally provisioned HTTPS base URL, run-token secret/control-plane access, provider-funded LiteLLM host, E2B API key from operator environment.
- Produces: explicit opt-in commands that fail closed when credentials/host are absent and produce sanitized smoke evidence under ignored `evals/results/`.

- [ ] **Step 1: Write RED smoke-contract tests with all external calls mocked**

Assert scripts refuse to start without explicit `LIVE_SMOKE=1`; never print secret env values; and enumerate every required check from the design.

- [ ] **Step 2: Implement HTTP gateway smoke workflow**

The live command must prove: bearer and `x-api-key` auth; claim-derived run; main/background models; unknown + disabled Chat Completions refusal; zero-cost token count; incremental SSE arrival through Caddy; first/idle/max/non-stream timeouts in controlled test endpoints/mocks where paid calls are unnecessary; real paid-call metering; delayed reconciliation; deliberate mismatch failure; distinct call IDs on repeat; crash/rerun spend retained; per-run cap.

- [ ] **Step 3: Implement E2B negative-network smoke workflow**

Against the P0-03 sandbox network phases, prove coding/testing can reach only the HTTPS gateway and cannot reach: a non-allowlisted hostname, a raw IPv4 address, an outside DNS name, or IPv6 egress.

- [ ] **Step 4: Include real LiteLLM hash-locked install preflight**

Smoke README/host bootstrap must use:

```bash
python -m pip install --require-hashes -r evals/litellm/requirements.txt
```

not CI's dry-run-only verification.

- [ ] **Step 5: Add package scripts that are never called by CI**

Use names such as `smoke:http-gateway` and `smoke:e2b-network`; each requires `LIVE_SMOKE=1` and external environment.

- [ ] **Step 6: Run mocked smoke-contract tests to GREEN**

- [ ] **Step 7: Commit**

```bash
git add evals/smoke evals/tests/smoke-contract.test.ts package.json
git commit -m "test(gateway): add opt-in credentialed Phase 0 smoke runners"
```

---

### Task 11: Full verification, documentation sync, and implementation PR

**Files:**
- Modify if needed: `evals/docs/phase-0/harness-http-gateway-design.md` only for implementation-truth clarifications that do not change approved behavior
- Modify: `evals/docs/phase-0/model-gateway.md` to link the harness HTTP surface and its non-idempotent crash semantics
- Modify: `evals/docs/phase-0/sandbox.md` to link the gateway smoke/E2B negative-network procedure

**Interfaces:**
- Consumes: all previous tasks.
- Produces: one reviewable P0-05 implementation branch with mocked CI green and explicit remaining operator/live-smoke gate.

- [ ] **Step 1: Run complete local/CI-equivalent checks**

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
python -m pip install --dry-run --require-hashes -r evals/litellm/requirements.txt
```

Expected: all pass; live smoke commands are not executed.

- [ ] **Step 2: Run targeted security/log scan**

Search committed changes for obvious credential literals and verify no prompt/output fixtures containing real benchmark/private material were introduced. Test fixtures use synthetic strings only.

- [ ] **Step 3: Verify frozen-route state**

Default config must show Chat Completions disabled and the other three approved routes enabled. If a real recorded transcript has not yet been run, do not invent evidence or enable it.

- [ ] **Step 4: Verify operator boundary**

Implementation may include deployment files, but it must not provision DigitalOcean, fund provider accounts, create E2B resources, or require secrets in public CI. Those actions wait for the operator.

- [ ] **Step 5: Update docs with links and exact crash semantics**

State explicitly: P0-04 control-plane call replay is idempotent; harness HTTP/stream traffic is not. A crashed harness attempt is rerun and all prior spend remains counted.

- [ ] **Step 6: Commit documentation sync**

```bash
git add evals/docs
git commit -m "docs(gateway): connect P0-05 HTTP gateway operations"
```

- [ ] **Step 7: Open implementation PR and stop for review**

PR body must list mocked verification results separately from **not-yet-run credentialed smoke** and must not claim end-to-end provider/E2B validation until the operator provisions the host/accounts and the live smoke actually passes.

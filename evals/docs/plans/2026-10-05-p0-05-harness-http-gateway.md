# P0-05 Harness-Facing HTTP and Streaming Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Phase 0 internet-facing provider-compatible HTTP gateway that unmodified coding harnesses can use with a short-lived run token, with strict route/model controls, unbuffered streaming, complete metering, and LiteLLM spend reconciliation.

**Architecture:** Extend the existing P0-04 gateway only where this surface needs shared run state: token claim verification, exact per-run model allowlists, and access to the run-scoped LiteLLM virtual key. Implement the public surface as a native Node 22 HTTP server under `evals/src/gateway/http/`, with explicit route specs, a separate harness-call store, direct LiteLLM pass-through, and bounded spend reconciliation. Keep control-plane idempotent calls and harness HTTP calls separate: control-plane calls can replay; harness requests always get a fresh server call ID and every incurred cost counts.

**Tech Stack:** TypeScript 5.9 strict mode, Node.js >=22 native `node:http`/WHATWG streams/fetch, Vitest 3, existing P0-04 `RunTokenService`/`GatewayStore`/LiteLLM virtual-key flow, LiteLLM `1.103.2` from the committed `--require-hashes` lock, Caddy, PostgreSQL, Docker Compose, E2B for credentialed smoke only.

**Spec:** `evals/docs/phase-0/harness-http-gateway-design.md`

## Global Constraints

- Keep Phase 0 code under `evals/`; no web/product code in this slice.
- Use native Node HTTP primitives; add no Node runtime dependency unless a later review explicitly approves it.
- `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, and `pnpm test` must remain green.
- Provider credentials, LiteLLM master credentials, run-token signing secrets, PostgreSQL passwords, and the E2B API key never enter the sandbox, prompt, log, committed file, or chat.
- Public auth accepts `Authorization: Bearer <run-token>` and `x-api-key: <run-token>`; if both exist they must match.
- Derive `runId` only from verified signed claims. Never trust a harness body/header/query run ID.
- Reject unauthenticated traffic before body parsing or other work.
- Persist an exact non-empty `allowedModels` set at `startRun()`; every paid main/background call must match it exactly.
- Enabled frozen routes: `POST /v1/messages`, `POST /v1/messages/count_tokens`, `POST /v1/responses`.
- Implement `POST /v1/chat/completions`, but keep it disabled until a recorded benchmark-harness transcript proves it is required.
- Authenticated unknown/disabled routes return sanitized `404` and create a safe refusal record.
- Token-count calls create normal call records with `listPriceCostUsd: 0` and are excluded from expected paid-spend reconciliation.
- Harness HTTP calls are not idempotent: strip incoming `Idempotency-Key`, generate a fresh server call ID, and count prior spend if a harness attempt crashes and is rerun.
- Maximum request body: 8 MiB. Sustained per-run rate: 120 requests/minute. Burst: 20.
- Non-streaming upstream timeout: 10 minutes. Streaming first-response timeout: 120 seconds. Streaming idle timeout: 90 seconds. Maximum stream duration: 20 minutes.
- Caddy must not buffer SSE. Preserve client-disconnect propagation so Node can attempt upstream cancellation; prove incremental delivery in live smoke.
- Default per-run spend cap remains $10. LiteLLM budget rejection must mark the persisted run `limit-hit` and refuse further paid work.
- Reconciliation polling: 500 ms initial delay, exponential backoff capped at 2 seconds, 30-second total timeout.
- Reconciliation monetary tolerance: absolute difference <= $0.000001; matching integer token counters must match exactly.
- Real validation budget: $25 prepaid OpenAI + $25 prepaid Anthropic, auto-reload disabled.
- Live LiteLLM installation must use `python -m pip install --require-hashes -r evals/litellm/requirements.txt`.
- Public CI uses mocks only: no live provider, LiteLLM, E2B, or paid calls.

## Review Focus

1. **Auth-before-body on hostile input:** malformed/huge chunked body with missing/conflicting credentials must be rejected without body consumption; Task 4.
2. **SSE framing across arbitrary chunks:** event lines/JSON may split anywhere; Task 6.
3. **Disconnect/timeout after spend starts:** cancel upstream where possible, preserve interrupted/timeout state, still reconcile spend; Tasks 6-7.
4. **Model-name confusion:** aliases/prefixes/case variation and a valid model from another run are refused; Tasks 1 and 4.
5. **Delayed/duplicate/unexpected LiteLLM spend rows:** wait for catch-up, then fail on missing/extra/duplicate/mismatched rows; Task 7.

---

### Task 1: Bind token claims and exact model allowlists to run state

**Files:**
- Modify: `evals/src/gateway/types.ts`
- Modify: `evals/src/gateway/run-token.ts`
- Modify: `evals/src/gateway/model-gateway.ts`
- Modify: `evals/tests/model-gateway.test.ts`
- Modify: `evals/tests/model-gateway-hardening.test.ts`

**Interfaces:**
- Produces: `RunTokenService.verifyClaims(token: string): RunTokenClaims`
- Produces: `StartRunRequest.allowedModels: readonly string[]`
- Produces: `GatewayRunRecord.allowedModels: readonly string[]`

- [ ] **Step 1: Write failing tests for claim-only verification**

Assert `verifyClaims(token)` returns signed `runId`/expiry without a caller-supplied run ID, rejects tampering and expiry, while existing `verify(token, expectedRunId)` still rejects cross-run use.

- [ ] **Step 2: Run focused tests and confirm RED**

```bash
pnpm exec vitest run evals/tests/model-gateway.test.ts evals/tests/model-gateway-hardening.test.ts
```

- [ ] **Step 3: Implement `verifyClaims()` without changing the token format**

Keep `verify(token, expectedRunId)` as `verifyClaims()` plus exact run-id comparison.

- [ ] **Step 4: Add required `allowedModels` to run contracts**

`startRun()` trims entries, rejects an empty list/empty item/duplicates after trimming, preserves exact case-sensitive model strings, and persists the frozen array. The allowlist is not embedded into the run token.

- [ ] **Step 5: Add cross-run/background-model tests**

One run allows `primary-model` + `background-model`; another has a different set; stored records never bleed allowlists across runs.

- [ ] **Step 6: Run focused tests to GREEN**

- [ ] **Step 7: Commit**

```bash
git add evals/src/gateway/types.ts evals/src/gateway/run-token.ts evals/src/gateway/model-gateway.ts evals/tests/model-gateway*.test.ts
git commit -m "feat(gateway): bind HTTP runs to claims and model allowlists"
```

---

### Task 2: Freeze route and limit configuration

**Files:**
- Create: `evals/config/http-gateway.json`
- Create: `evals/src/gateway/http/types.ts`
- Create: `evals/src/gateway/http/config.ts`
- Create: `evals/src/gateway/http/route-registry.ts`
- Test: `evals/tests/http-route-registry.test.ts`

**Interfaces:**
- Produces: `HarnessHttpConfig`, `HarnessRouteSpec`, `loadHarnessHttpConfig()`, `getHarnessRoute(method, path, config)`.

- [ ] **Step 1: Write failing config tests that pin exact defaults**

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

Messages, token-count, and Responses are enabled; Chat Completions exists but is disabled; unknown method/path has no route.

- [ ] **Step 2: Run focused test and confirm RED**

- [ ] **Step 3: Implement strict route specs**

Each route declares method/path, `wireApi`, enabled flag, streaming support, paid/zero-cost flag, model field, forwarded request-header allowlist, safe response headers, and safe model-setting fields. No wildcard route.

- [ ] **Step 4: Require transcript evidence before enabling Chat Completions**

If `/v1/chat/completions` becomes enabled, config validation requires `routeEvidence.chatCompletionsTranscriptSha256` as 64 hex characters. Default committed config has it disabled and no evidence hash.

- [ ] **Step 5: Run focused tests to GREEN**

- [ ] **Step 6: Commit**

```bash
git add evals/config/http-gateway.json evals/src/gateway/http evals/tests/http-route-registry.test.ts
git commit -m "feat(gateway): freeze provider-compatible HTTP route policy"
```

---

### Task 3: Add durable harness-call and refusal storage

**Files:**
- Create: `evals/src/gateway/http/store.ts`
- Create: `evals/src/gateway/http/file-store.ts`
- Test: `evals/tests/http-call-store.test.ts`

**Interfaces:**

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

`HarnessCallRecord` includes run/call identity, route/wire API, provider/model, safe model settings, paid flag, lifecycle state, normalized usage, latency, LiteLLM correlation ID, reconciled cost, and timestamps. It excludes prompt/body/output/credential values.

- [ ] **Step 1: Write failing per-run isolation and secret-exclusion tests**

Corrupt/add a second run's files and prove listing run A never reads run B. Inspect serialized JSON and assert synthetic prompt/auth/upstream-key strings are absent.

- [ ] **Step 2: Run test and confirm RED**

- [ ] **Step 3: Implement `FileHarnessCallStore` with hashed per-run directories and `0600` atomic writes**

Use separate `harness-calls/<run-hash>/` and `harness-refusals/<run-hash>/`; never reuse P0-04 idempotency-call storage.

- [ ] **Step 4: Reject immutable identity mutation**

`saveCall()` may change state/usage/cost, but not `runId`, `callId`, route, provider, model, or paid flag.

- [ ] **Step 5: Run focused tests to GREEN**

- [ ] **Step 6: Commit**

---

### Task 4: Enforce auth, rate/body limits, exact model authorization, and safe refusals

**Files:**
- Create: `evals/src/gateway/http/auth.ts`
- Create: `evals/src/gateway/http/rate-limiter.ts`
- Create: `evals/src/gateway/http/request-body.ts`
- Create: `evals/src/gateway/http/handler.ts`
- Test: `evals/tests/http-auth-and-limits.test.ts`

**Interfaces:**
- Produces: `authenticateHarnessRequest(headers): { token: string; claims: RunTokenClaims }`
- Produces: `RunTokenBucket`
- Produces: `readJsonBodyWithinLimit()`
- Produces: `createHarnessHttpHandler(options)`

- [ ] **Step 1: Write failing auth matrix tests**

Bearer only, `x-api-key` only, matching dual headers, conflicting dual headers, malformed bearer, expired token, finished/limit-hit run, and cross-run token behavior.

- [ ] **Step 2: Prove auth happens before body consumption**

Use a request body stream that throws if read. Missing/conflicting auth returns `401` without reading. Authenticated >8 MiB chunked input returns `413` before full consumption.

- [ ] **Step 3: Write per-token rate-limit tests**

Token bucket starts with burst 20 and refills at 2 requests/second. Key limiter state by SHA-256 of the run token, never the raw token string. Exhaustion returns `429` before upstream work.

- [ ] **Step 4: Write model/refusal/error-shape tests**

Primary/background exact models pass. Prefix/alias/case variation and a model only allowed in another run return sanitized provider-compatible `400`. Unknown/disabled routes return sanitized `404`; `/v1/chat/completions` is refused by default. One safe refusal record per authenticated refusal.

- [ ] **Step 5: Run focused test and confirm RED**

- [ ] **Step 6: Implement guard order exactly**

Credential parse -> signed claims -> active run -> rate limit -> route lookup/enabled -> bounded body parse -> exact model check -> dispatch. Refusal logs contain only run ID, timestamp, method, normalized path, and reason.

- [ ] **Step 7: Run focused tests to GREEN**

- [ ] **Step 8: Commit**

---

### Task 5: Implement LiteLLM pass-through and non-streaming calls

**Files:**
- Create: `evals/src/gateway/http/upstream.ts`
- Create: `evals/src/gateway/usage.ts`
- Modify: `evals/src/gateway/litellm-adapter.ts`
- Modify: `evals/src/gateway/http/handler.ts`
- Test: `evals/tests/http-nonstreaming.test.ts`
- Modify: `evals/tests/model-gateway.test.ts`

**Interfaces:**
- Produces: `LiteLLMHarnessTransport.forward(request, signal): Promise<Response>`
- Produces: shared `normalizeModelUsage(wireApi, body): ModelUsage`

- [ ] **Step 1: Extract current P0-04 usage normalization under existing green tests**

Move it from `litellm-adapter.ts` to `usage.ts` without semantic change.

- [ ] **Step 2: Write failing header/credential forwarding tests**

Strip incoming `Authorization`, `x-api-key`, and `Idempotency-Key`; inject only the hidden run-scoped LiteLLM virtual key upstream. Inject a server-generated correlation/call ID and spend metadata. Never return the upstream credential or secret headers to the client.

- [ ] **Step 3: Prove harness HTTP is non-idempotent**

Two identical HTTP requests yield two call IDs, two upstream requests, and two call records.

- [ ] **Step 4: Add non-streaming timeout test**

With a tiny override, timeout aborts upstream and stores call state `timeout`.

- [ ] **Step 5: Add spend-cap rejection test**

Mock LiteLLM returning its budget/spend-limit rejection. Assert the gateway saves the run as `limit-hit`, returns sanitized `429`, does not create a fake successful/replayable call, and all later paid requests for that run are refused before upstream work.

- [ ] **Step 6: Implement non-streaming forwarding**

Forward only already-size-bounded accepted JSON and approved headers. Preserve provider-compatible status/body/content type. Persist normalized usage; authoritative cost is finalized by reconciliation.

- [ ] **Step 7: Implement token count as a zero-cost call**

Forward `/v1/messages/count_tokens`, create a fresh call record with `paid: false` and `listPriceCostUsd: 0`, and keep it outside paid-spend expectations.

- [ ] **Step 8: Run focused + existing gateway tests to GREEN**

```bash
pnpm exec vitest run evals/tests/http-nonstreaming.test.ts evals/tests/model-gateway.test.ts evals/tests/model-gateway-hardening.test.ts
```

- [ ] **Step 9: Commit**

---

### Task 6: Pass SSE through incrementally and meter stream usage

**Files:**
- Create: `evals/src/gateway/http/sse.ts`
- Create: `evals/src/gateway/http/stream-proxy.ts`
- Modify: `evals/src/gateway/http/handler.ts`
- Test: `evals/tests/http-streaming.test.ts`

**Interfaces:**
- Produces: `SseEventParser.push(chunk): readonly SseEvent[]`
- Produces: `proxyMeteredStream(options): Promise<StreamCompletion>`

- [ ] **Step 1: Write RED tests for arbitrary SSE chunk boundaries**

Anthropic and OpenAI Responses terminal usage must parse correctly when UTF-8/text lines/JSON cross chunk boundaries.

- [ ] **Step 2: Prove true incremental pass-through**

Release three upstream chunks one at a time and assert each reaches the client before the next is released; no full-response buffer.

- [ ] **Step 3: Write first-response, idle, and max-duration timeout tests**

Each aborts upstream, persists `timeout`, and remains eligible for spend reconciliation.

- [ ] **Step 4: Write client-disconnect test**

Closing the client after the first event aborts upstream where possible and persists `interrupted`; spend is still reconciled later.

- [ ] **Step 5: Implement side-band SSE parsing**

Use streaming `TextDecoder`; write raw bytes immediately and parse a copy. Do not rewrite event payloads.

- [ ] **Step 6: Normalize terminal usage**

Anthropic Messages and OpenAI Responses use the same P0-04 token semantics. Implement Chat Completions parsing too, but it remains unreachable while disabled.

- [ ] **Step 7: Run focused tests to GREEN**

- [ ] **Step 8: Commit**

---

### Task 7: Reconcile paid harness calls against delayed LiteLLM spend logs

**Files:**
- Create: `evals/src/gateway/http/litellm-spend.ts`
- Create: `evals/src/gateway/http/reconciler.ts`
- Test: `evals/tests/http-reconciliation.test.ts`

**Interfaces:**
- Produces: `LiteLLMSpendClient.listRunSpend(upstreamCredential): Promise<readonly LiteLLMSpendRecord[]>`
- Produces: `reconcileRunSpend(runId, options): Promise<ReconciliationResult>`

- [ ] **Step 1: Write delayed-catch-up RED test**

Mock no rows -> partial rows -> all rows. With injected sleep/clock, assert 500 ms initial delay, exponential growth capped at 2 s, and success before the 30 s deadline.

- [ ] **Step 2: Write reconciliation-failure RED tests**

Missing paid call after timeout, unexpected extra paid row, duplicate correlation ID, cost delta >$0.000001, and matching integer-token mismatch must fail finalization clearly.

- [ ] **Step 3: Test zero-cost and interrupted calls**

Token-count requires no paid row. Interrupted/timeout paid calls may fill missing terminal usage from LiteLLM spend data while preserving their interrupted/timeout state.

- [ ] **Step 4: Implement run-key-scoped spend retrieval**

Use the pinned LiteLLM management API with the admin credential and filter by the run virtual key. Match rows using the gateway-controlled call ID stored in LiteLLM spend metadata/correlation fields. Never expose either credential.

- [ ] **Step 5: Implement bounded reconciliation and aggregate spend**

Only after catch-up, persist authoritative cost/available usage into call records and return run total.

- [ ] **Step 6: Run focused tests to GREEN**

- [ ] **Step 7: Commit**

---

### Task 8: Add record-and-forward protocol capture

**Files:**
- Create: `evals/src/gateway/http/protocol-recorder.ts`
- Create: `evals/src/gateway/http/recorder-cli.ts`
- Create: `evals/src/gateway/http/transcript.ts`
- Test: `evals/tests/protocol-recorder.test.ts`
- Modify: `.gitignore`

**Interfaces:**
- Produces: sanitized `ProtocolTranscript` plus SHA-256 evidence digest.

- [ ] **Step 1: Write safe-recording RED tests**

Synthetic auth values, prompts, tool args, and model output must not appear. Record only harness/version, method/path, non-secret header names, content type, top-level field names, requested model, stream flag, response status/content type.

- [ ] **Step 2: Write record-and-forward continuation test**

Background-model/token-count traffic occurs only after a realistic first model response. The recorder must forward/answer enough to expose all traffic; a log-only stub fails this test.

- [ ] **Step 3: Implement recorder as an explicit non-gate mode**

Require a dedicated recorder credential and separate CLI/mode. Transparent forwarding is allowed only in this controlled recorder; normal gateway remains strict.

- [ ] **Step 4: Write sanitized transcript under ignored `evals/results/protocol/` and emit SHA-256**

Chat Completions can be enabled later only by putting that transcript digest into frozen config.

- [ ] **Step 5: Run focused tests to GREEN**

- [ ] **Step 6: Commit**

---

### Task 9: Package the Node service and deployment stack

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
- Produces: runnable public gateway behind Caddy; private/loopback health only.

- [ ] **Step 1: Write server/config RED tests**

Missing signing/LiteLLM/store settings fail closed; no unauthenticated public health route; `.env.example` contains empty placeholders only.

- [ ] **Step 2: Add deployment static tests**

Compose topology is Caddy -> Node gateway -> LiteLLM/Postgres. LiteLLM image is built from the hash-locked requirements with real `pip install --require-hashes`. External images are pinned by immutable digest when committed; no floating `latest` tags.

- [ ] **Step 3: Implement native server/CLI and graceful shutdown**

SIGTERM/SIGINT stops new requests and gives active streams a bounded drain before abort.

- [ ] **Step 4: Configure Caddy for SSE without defeating disconnect cancellation**

Do not configure response buffering. Preserve `text/event-stream`; do not use a proxy mode that intentionally keeps backend work alive after the client disconnects. Live smoke is the authority for one-event-at-a-time delivery and disconnect propagation.

- [ ] **Step 5: Document operator prerequisites**

DigitalOcean 2-vCPU/4-GB Phase 0 target, DNS/HTTPS, public 443 only, restricted SSH, $25 prepaid/provider with auto-reload off, E2B account/key, and host-only secrets. Do not provision or fund anything in this task.

- [ ] **Step 6: Run focused tests to GREEN**

- [ ] **Step 7: Commit**

---

### Task 10: Add opt-in credentialed smoke runners

**Files:**
- Create: `evals/smoke/http-gateway-smoke.ts`
- Create: `evals/smoke/e2b-network-smoke.ts`
- Create: `evals/smoke/README.md`
- Modify: `package.json`
- Test: `evals/tests/smoke-contract.test.ts`

**Interfaces:**
- Produces: explicit `LIVE_SMOKE=1` commands that never run in public CI and emit sanitized evidence to ignored `evals/results/`.

- [ ] **Step 1: Write mocked smoke-contract RED tests**

Scripts fail closed without `LIVE_SMOKE=1`, never print secret env values, and enumerate every required smoke assertion.

- [ ] **Step 2: Implement HTTP gateway smoke workflow**

Prove auth forms, claim-derived run, main/background model allowlists, unknown + disabled Chat Completions refusal, zero-cost token count, incremental SSE through Caddy, timeout behavior, real paid-call metering, delayed reconciliation, deliberate mismatch failure, distinct call IDs, crash/rerun spend retention, and per-run cap.

- [ ] **Step 3: Implement E2B negative-network smoke workflow**

During coding/testing, prove gateway reachability and block a non-allowlisted hostname, raw IPv4, outside DNS name, and IPv6 egress.

- [ ] **Step 4: Require real hash-locked LiteLLM install in smoke bootstrap**

```bash
python -m pip install --require-hashes -r evals/litellm/requirements.txt
```

- [ ] **Step 5: Add `smoke:http-gateway` and `smoke:e2b-network` package scripts**

Neither is referenced from CI.

- [ ] **Step 6: Run mocked smoke-contract tests to GREEN**

- [ ] **Step 7: Commit**

---

### Task 11: Full verification, documentation sync, and implementation PR

**Files:**
- Modify: `evals/docs/phase-0/model-gateway.md`
- Modify: `evals/docs/phase-0/sandbox.md`
- Modify only if implementation truth needs clarification: `evals/docs/phase-0/harness-http-gateway-design.md`

- [ ] **Step 1: Run the full CI-equivalent verification**

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
python -m pip install --dry-run --require-hashes -r evals/litellm/requirements.txt
```

Live smoke is intentionally not part of this command.

- [ ] **Step 2: Scan committed changes for credential/prompt leakage**

Fixtures remain synthetic. No secret literals, private tickets, hidden tests, real prompt/output data, or provider credentials.

- [ ] **Step 3: Verify frozen route state**

Messages, token-count, Responses enabled; Chat Completions disabled unless a real recorder artifact exists. Never invent transcript evidence.

- [ ] **Step 4: Verify operator boundary**

Deployment files are allowed; actual DigitalOcean provisioning, provider funding, E2B resource creation, DNS changes, and secret entry remain operator actions.

- [ ] **Step 5: Sync docs with the crash boundary**

State explicitly: P0-04 control-plane calls can replay idempotently; harness HTTP/stream calls cannot. A crashed harness attempt is rerun and prior spend remains counted.

- [ ] **Step 6: Commit docs**

- [ ] **Step 7: Open the P0-05 implementation PR and stop for review**

PR body must separate mocked CI evidence from **not-yet-run live provider/E2B smoke**. Do not claim end-to-end validation until the operator provisions the host/accounts and the smoke run actually passes.

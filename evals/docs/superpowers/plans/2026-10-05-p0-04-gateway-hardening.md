# P0-04 Gateway Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three review gaps in PR #5 and make the LiteLLM Python dependency reproducible with hash-verified installation.

**Architecture:** Keep the existing ModelGateway/LiteLLM split. Harden only storage layout, idempotency request identity, token accounting normalization, and the LiteLLM requirements lock. No HTTP server, harness runner, collector, routing, or product code is added in this PR.

**Tech Stack:** TypeScript, Vitest, Node.js fs/crypto, LiteLLM proxy 1.103.2, pip requirements hashes.

**Spec:** PR #5 review requirements from 2026-10-05.

## Global Constraints

- Every unique paid call produces one durable cost row.
- Reusing an idempotency key with a different model request is rejected.
- `inputTokens` has one cross-provider meaning: total input tokens consumed, including cache reads and cache writes where the provider reports them.
- `cacheWriteInputTokens` is tracked separately.
- CI remains mocked-only; no provider keys or live model calls.
- LiteLLM remains exactly version `1.103.2` and installs with `--require-hashes`.

## Review Focus

- Another run's stored-call files must never be opened while listing one run's costs.
- Canonically equivalent JSON objects must hash identically; changed model/settings/body/wire API must conflict on the same idempotency key.
- OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages must normalize input/cache fields consistently.
- Existing 36 tests must remain green in addition to new tests.
- Hash-pinned requirements must be installable in a clean Python environment.

---

### Task 1: Per-run call storage

**Files:**
- Modify: `evals/src/gateway/file-store.ts`
- Test: `evals/tests/model-gateway.test.ts`

- [ ] Add a failing test that corrupts another run's call file and proves `listCostRecords(runA)` still succeeds.
- [ ] Move call files to `calls/<run-digest>/<idempotency-digest>.json` and list only that directory.
- [ ] Run the gateway tests and verify green.

### Task 2: Idempotency request fingerprint

**Files:**
- Modify: `evals/src/gateway/types.ts`
- Modify: `evals/src/gateway/model-gateway.ts`
- Add: `evals/src/gateway/request-hash.ts`
- Test: `evals/tests/model-gateway.test.ts`

- [ ] Add a failing test that reuses one key with a changed request and expects rejection with no second provider call.
- [ ] Store a canonical SHA-256 over wire API, model, settings, and body with every stored call.
- [ ] Compare the fingerprint before replaying a stored response.
- [ ] Run the gateway tests and verify green.

### Task 3: Cross-wire usage normalization

**Files:**
- Modify: `evals/src/gateway/types.ts`
- Modify: `evals/src/gateway/litellm-adapter.ts`
- Modify: `evals/src/gateway/model-gateway.ts`
- Modify: `evals/src/domain/run-result.ts`
- Test: `evals/tests/model-gateway.test.ts`

- [ ] Add one failing normalization test for each wire API.
- [ ] Define `inputTokens` as total input tokens; add `cacheWriteInputTokens` to usage/cost/summary/result-row types.
- [ ] Normalize OpenAI cache reads as subsets of total input and Anthropic total input as base + cache read + cache write.
- [ ] Run all TypeScript checks and tests.

### Task 4: Hash-verified LiteLLM pin

**Files:**
- Modify: `evals/litellm/requirements.txt`
- Modify: `evals/docs/phase-0/model-gateway.md`

- [ ] Generate a fully pinned dependency set for `litellm[proxy]==1.103.2` with hashes.
- [ ] Put `--require-hashes` in the requirements file and verify a clean pip install succeeds.
- [ ] Document that the later HTTP/streaming slice is separate from this PR.

### Task 5: Final verification

- [ ] Run frozen pnpm install, lint, typecheck, and all tests.
- [ ] Confirm CI is green on the final PR head.
- [ ] Mark PR #5 ready for review and stop.

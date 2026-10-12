# Part B2 Orchestration and Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace B1's fake-only execution path with resumable, safety-bounded product orchestration over the existing Phase 0 sandbox/gateway/harness contracts, with independent baseline/clean-copy verification and reviewable task results.

**Architecture:** Migration `0007` corrects B1 worker privilege/audit/progress semantics without editing applied migration `0006`. The worker connects as `coding_agent_worker`, claims globally only through narrow SECURITY DEFINER functions, then enters the claimed tenant with the existing `withTenant()` helper. Product orchestration separates source preparation, paid coding, patch safety, and model-free verification so durable milestones can prevent paid reruns after lease reclaim.

**Tech Stack:** Node 22, TypeScript, PostgreSQL 16, pg, Next.js 16/React 19, Vitest, existing Phase 0 `SandboxProvider`, `HarnessRunner`, `ModelGateway`/run-token contracts.

**Spec:** `docs/superpowers/specs/2026-10-09-part-b-task-execution-delivery-design.md`

## Global Constraints

- Base is merged `main` at `20bec70b2435e8ce80fde9b443db06e6256f0b54`.
- Migration `0006_task_execution.sql` is applied and immutable. Add only `0007_task_execution_b2.sql` and its checksum.
- `coding_agent_api` remains API-only. `coding_agent_worker` is `NOSUPERUSER NOBYPASSRLS NOINHERIT`, has no direct table privileges, and gets queue-function EXECUTE only.
- Worker tenant reads/writes occur through `withTenant()` after claim returns the organization id.
- CI/tests never make paid model calls or live E2B calls. All sandbox/harness/gateway behavior in CI is fake/recorded.
- No GitHub publication or branch write, ZIP promotion, automatic merge, or automatic paid rerun in B2.
- The exact planner-read GitHub SHA / ZIP version id is the source pin at `plan_ready`.
- Coding sandboxes never receive GitHub App private keys/tokens, DB credentials, LiteLLM admin credentials, Supabase secrets, or publication credentials.
- Owner-run live smoke exists only behind explicit flags and is never executed by CI or this implementation session.

## Review Focus

- Lease expires after model coding begins: same attempt must fail `WORKER_INTERRUPTED`; claim must not invoke the model again.
- Baseline test/build already fails: same failure on clean patched source is `pre_existing`, not `verification_failed`; only a new failure blocks.
- Patch tries path traversal, symlink, CI workflow/config, exceeds file/byte caps, or contains a detected secret: reject before artifact/download persistence.
- Planner reads GitHub default-head SHA different from `project_reports.analysed_commit`: `planned_source_commit_sha` must equal the SHA actually read.
- Worker role attempts direct tenant-table access or API role attempts queue claim: both must fail; worker tenant access succeeds only through `withTenant()` for the claimed organization.

---

### Task 1: Migration 0007, worker role, durable progress, terminal audit, immutable history

**Files:**
- Create: `packages/db/migrations/0007_task_execution_b2.sql`
- Modify: `packages/db/migrations/checksums.json`
- Create: `packages/db/tests/task-execution-b2.test.ts`
- Create/modify: focused migration contract tests under `packages/db/tests/`

**Interfaces:**
- Adds durable timestamps on `task_executions`: `source_prepared_at`, `coding_started_at`, `coding_finished_at`, `patch_exported_at`, `verified_at`.
- Extends terminal execution states for B2 with `verification_failed` and `fix_not_reproduced`.
- Replaces queue functions so only `coding_agent_worker` can claim/heartbeat/finish.
- `claim_task_execution` marks an expired execution `failed/WORKER_INTERRUPTED` when `coding_started_at IS NOT NULL AND coding_finished_at IS NULL`; it never reclaims that paid step.
- Worker terminal functions write `task_execution_succeeded`, `task_execution_failed`, `task_execution_cancelled`, or `task_execution_timed_out` audit rows transactionally.

- [ ] Write RED migration tests for role attributes, no direct table grants, `coding_agent_worker` membership in `coding_agent_app`, API queue EXECUTE revocation, DELETE revocation, durable progress columns, interrupted-coding terminal handling, and terminal audit events.
- [ ] Run serial PostgreSQL tests and verify RED because `0007` does not exist.
- [ ] Implement `0007`, preserving `0006` byte-for-byte, and add only the new checksum.
- [ ] Run real PostgreSQL tests GREEN, including direct-access denial and `withTenant()`-style role transition success.

### Task 2: Planner-read source pin and runnable worker entrypoint

**Files:**
- Modify: `apps/api/src/project-code-reader.ts`
- Modify: `apps/api/src/hybrid-project-code-reader.ts`
- Modify: `apps/api/src/task-database.ts`
- Modify: `apps/api/src/task-service.ts`
- Modify/add: `apps/api/tests/task-service.test.ts`, `apps/api/tests/project-code-reader.test.ts`, integration coverage as needed
- Modify: `apps/worker/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `apps/worker/src/cli.ts`
- Modify: `apps/worker/src/main.ts`
- Modify: `README.md`
- Create/modify: worker entrypoint tests

**Interfaces:**
- `ProjectCodeContext` gains an immutable source pin: `{ source: "github"; commitSha: string } | { source: "upload"; versionId: string }` while retaining human/debug `revision` text.
- `TaskDatabase.savePlan(session, taskId, plan, sourcePin)` stores that pin in the same transition to `plan_ready`; migration 0007's trigger validates/preserves the supplied pin rather than replacing it with `project_reports` data.
- `pnpm --filter @coding-agent/worker dev` runs `tsx src/cli.ts`.
- CLI requires `DATABASE_URL` username `coding_agent_worker`, `TASK_EXECUTION_WORKER_ID`, handles SIGINT/SIGTERM with `AbortController`, and closes the pool.

- [ ] Write RED regression test where project report SHA=A but `ProjectCodeReader` returns SHA=B; assert saved task pin is B.
- [ ] Write RED upload test proving current upload version id, not archive SHA text, becomes the plan pin.
- [ ] Implement source-pin flow through planner/savePlan and run task/API tests GREEN.
- [ ] Write RED worker CLI/package contract test for `dev` script, restricted worker URL, worker id, signals, and pool close.
- [ ] Implement CLI/worker startup and README local command, then run worker tests GREEN.

### Task 3: Resumable B2 execution store and orchestration contracts

**Files:**
- Create: `apps/worker/src/execution-store.ts`
- Modify: `apps/worker/src/postgres-execution-queue.ts`
- Modify: `apps/worker/src/task-execution-worker.ts`
- Create: `apps/worker/src/product-coding-runner.ts`
- Create: `apps/worker/src/product-execution-orchestrator.ts`
- Create: `apps/worker/src/execution-source.ts`
- Create/modify: `apps/worker/tests/*`
- Modify: `apps/worker/src/index.ts`

**Interfaces:**
- `ExecutionStore` uses `withTenant(pool, { organizationId })` for task/report/source/result/check/artifact/model-cost reads/writes and progress milestones.
- `ProductCodingRunner` is the product adapter over Phase 0 `SandboxProvider` + `HarnessRunner`; real contracts are constructor dependencies, so CI injects fakes.
- `ProductExecutionOrchestrator.run(execution, { signal })` performs: source prepare -> baseline -> coding -> patch export persistence -> safety scan -> fresh clean-copy verification -> reproduce proof -> change document/result persistence.
- `runExecutionWorkerOnce` consults durable milestones before runner invocation. Reclaimed interrupted coding is already terminal from the queue; completed safe milestones are not repeated unnecessarily.

- [ ] Write RED unit tests proving no model/harness call after `coding_started` without `coding_finished`, safe continuation after persisted `patch_exported`, and tenant store calls `withTenant` for the claimed organization.
- [ ] Implement execution store and queue/result types; run focused tests GREEN.
- [ ] Write RED contract test proving `ProductCodingRunner` uses existing `SandboxProvider`/`HarnessRunner` and does not expose server credentials to sandbox requests.
- [ ] Implement runner/orchestrator boundaries with fakes; run worker suite GREEN.

### Task 4: Baseline, clean-copy verification, reproduce-first, patch safety, change document, cost

**Files:**
- Create: `apps/worker/src/verification.ts`
- Create: `apps/worker/src/patch-safety.ts`
- Create: `apps/worker/src/secret-scan.ts`
- Create: `apps/worker/src/change-document.ts`
- Modify: `apps/worker/src/product-execution-orchestrator.ts`
- Modify: `apps/worker/src/execution-store.ts`
- Create/modify: worker tests and real PostgreSQL integration tests

**Interfaces:**
- `verifyExecution(...)` creates model-free sandbox sessions from the approved source, runs report install/test/build commands on baseline, applies only the exported patch to a second fresh source copy, and classifies each patched failure against baseline.
- Bug-task reproduce proof executes the runner-added reproduction test on clean approved source (must fail) and clean patched source (must pass); otherwise result is `fix_not_reproduced`, not a proven fix.
- `inspectPatchSafety(patch, limits)` returns changed files/bytes, dependency/lockfile flags, and rejects traversal/root escape, symlink mode, `.github/workflows/**` and configured CI paths, cap violations, or secret findings.
- Successful/non-proven review results store a sanitized change document and total linked model-call cost; raw ticket/transcript/secret content is excluded.

- [ ] Write RED tests for baseline pre-existing failure classification and second-fresh-sandbox verification.
- [ ] Write RED reproduce-first fail-before/pass-after and no-reproduction cases.
- [ ] Write RED patch-safety/secret tests covering traversal, symlink diff modes, CI paths, file/byte caps, dependency flags, and representative credential patterns.
- [ ] Implement minimal verification/safety pipeline and persist checks/artifacts/results only after safety scan; run worker + PostgreSQL tests GREEN.
- [ ] Write RED change-document test for required fields and prohibited raw-ticket/PII/transcript/secret material; implement and run GREEN.

### Task 5: Task result UI, ZIP diff, cost, and waiting-worker state

**Files:**
- Modify: `apps/api/src/task-execution-database.ts`
- Modify: `apps/api/src/task-execution-service.ts`
- Modify as needed: `apps/api/src/task-execution-server.ts`
- Modify: `apps/web/components/task-execution-status.tsx`
- Create/modify: API/web tests

**Interfaces:**
- Execution API returns progress milestones, checks, sanitized change document, diff text/metadata, dependency/lockfile flags, reproduce proof, and `costUsd` for the latest execution.
- Browser shows `Waiting for a worker.` after 60 seconds in `queued` status, otherwise current queued/running/terminal copy.
- ZIP tasks display the in-app execution diff in B2; no new immutable ZIP version or promotion occurs until B4.

- [ ] Write RED API/web tests for 60-second waiting copy, cost/result/check display, fix-not-reproduced copy, verification-failed copy, dependency flags, and ZIP diff rendering.
- [ ] Implement read model and UI, keeping signed-in heading scale unchanged; run API/web tests and production build GREEN.

### Task 6: Owner-run live smoke, full verification, PR

**Files:**
- Create: `scripts/b2-live-smoke.ts` (or repo-conventional equivalent after final inspection)
- Modify: `README.md`
- Create: test asserting explicit smoke flags and CI-safe default

**Interfaces:**
- Smoke script exits unless both explicit live flags are present (including acknowledgement that paid model/E2B calls may occur), validates required environment, runs one owner-selected execution through real sandbox/gateway/harness wiring, and is never invoked by normal tests/CI.

- [ ] Write RED contract test for explicit opt-in flags and absence from CI scripts.
- [ ] Implement smoke script and documentation; do **not** execute it.
- [ ] Run frozen install, lint, typecheck, full parallel + serial PostgreSQL tests, Next production build, and LiteLLM hash lock.
- [ ] Review diff against B2 boundaries only. Verify `0006` unchanged and no B3/B4 publication/promotion code.
- [ ] Open one B2 PR with exact head SHA, CI evidence, all covered failure states and exact user-visible behavior; stop for review without merging.

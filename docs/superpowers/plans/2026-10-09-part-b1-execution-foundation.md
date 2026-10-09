# Part B1 Execution Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish durable, tenant-safe task execution attempts with source pinning, PostgreSQL queue leases, cancel/timeout controls, a fake coding runner, and task-page execution status.

**Architecture:** Source is pinned transactionally when planning reaches `plan_ready`. Tenant API operations use `withTenant`; the worker claims cross-tenant queue rows only through narrow SECURITY DEFINER functions using `FOR UPDATE SKIP LOCKED`. B1 uses a deterministic fake `CodingRunner`; real sandbox/model/harness orchestration is deferred to B2.

**Tech Stack:** Node 22, TypeScript, PostgreSQL 16, pg, Next.js 16/React 19, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-09-part-b-task-execution-delivery-design.md`

## Global Constraints

- Base is merged `main` at `ff4934a012ea8407b363a28c84a04481b0a7b611`.
- Never edit applied migrations `0001`–`0005`; add only `0006_task_execution.sql` and its checksum.
- All tenant-owned relationships retain composite organization-scoped foreign keys and FORCE RLS.
- API and worker run as restricted `coding_agent_api`, never postgres/superuser.
- One active execution per task; start is idempotent; later retries are separate explicit attempts.
- Rep control is limited to the task owner; developers and owners may start/cancel any tenant task.
- Budget and wall-clock timeout are copied into each execution at start.
- No paid model calls, live E2B calls, GitHub publication, or automatic reruns in B1.

## Review Focus

- Two concurrent starts for one task must converge on the same active execution, not create two attempts.
- A worker crash/expired lease must allow the same execution row to be reclaimed without creating a new attempt.
- Cancellation and timeout must win over a late fake-runner success and leave nothing published.
- Planning must pin exactly the report source used for the plan: GitHub commit or ZIP version, never both.
- Cross-tenant users and unauthorized reps must not start, cancel, claim, or inspect another tenant's execution.

---

### Task 1: Migration 0006 and source pin contract

**Files:**
- Create: `packages/db/migrations/0006_task_execution.sql`
- Modify: `packages/db/migrations/checksums.json`
- Create: `packages/db/tests/task-execution.test.ts`
- Modify: `apps/api/src/task-database.ts`
- Modify/add task database tests under `apps/api/tests/`

**Interfaces:**
- Produces `tasks.planned_source_commit_sha` / `tasks.planned_source_version_id`.
- Produces tenant tables `task_executions`, `task_execution_checks`, `task_execution_artifacts` and nullable `model_calls.task_execution_id`.
- Produces worker queue functions `claim_task_execution`, `heartbeat_task_execution`, and `finish_task_execution` callable only by `coding_agent_api`.

- [ ] Add RED tests for immutable migration numbering, source-pin exclusivity, composite FKs/RLS/grants, one-active-execution index, execution cost linkage, and queue functions containing `FOR UPDATE SKIP LOCKED`.
- [ ] Run the PostgreSQL test suite and confirm RED.
- [ ] Implement migration `0006`, add only its SHA-256 checksum, and make the real restricted-role PostgreSQL tests GREEN.
- [ ] Add RED task-database test showing `savePlan` must copy the current report's analysed commit/version into the task in the same transaction.
- [ ] Update `savePlan` and TaskDetail source-pin fields; run task tests GREEN.

### Task 2: Tenant execution API and idempotent control

**Files:**
- Create: `apps/api/src/task-execution-database.ts`
- Create: `apps/api/src/task-execution-service.ts`
- Modify: `apps/api/src/task-http.ts`
- Modify: `apps/api/src/task-server.ts`
- Modify: `apps/api/src/main.ts`
- Create: `apps/api/tests/task-execution-http.integration.test.ts`
- Add focused unit tests under `apps/api/tests/`

**Interfaces:**
- `TaskExecutionService.get(session, taskId)` returns the latest execution or null.
- `TaskExecutionService.start(session, taskId)` returns `{ execution, created }` and snapshots configured budget/timeout.
- `TaskExecutionService.cancel(session, taskId)` returns the active/just-cancelled execution.
- Routes: `GET /api/tasks/:taskId/execution`, `POST /api/tasks/:taskId/execution/start`, `POST /api/tasks/:taskId/execution/cancel`.

- [ ] Add RED tests for approved-task requirement, pinned-source requirement, owner/developer/task-owner-rep authorization, other-rep refusal, idempotent concurrent start, separate later attempts, cancel queued/running, and tenant isolation.
- [ ] Implement tenant database/service operations with `withTenant`, partial-unique active-row protection, `INSERT ... ON CONFLICT DO NOTHING`, and append-only audit events.
- [ ] Wire routes and main configuration using `TASK_EXECUTION_BUDGET_USD` and `TASK_EXECUTION_TIMEOUT_SECONDS`; run API unit/integration tests GREEN.

### Task 3: PostgreSQL worker and fake CodingRunner

**Files:**
- Modify: `apps/worker/package.json`
- Modify: `pnpm-lock.yaml` only as required for the worker's already-pinned pg tooling.
- Create: `apps/worker/src/task-execution-worker.ts`
- Create: `apps/worker/src/postgres-execution-queue.ts`
- Create: `apps/worker/src/fake-coding-runner.ts`
- Modify: `apps/worker/src/index.ts`
- Create: `apps/worker/tests/task-execution-worker.test.ts`
- Extend PostgreSQL integration coverage as needed.

**Interfaces:**
- `CodingRunner.run(execution, { signal })` returns deterministic success/failure in B1.
- `PostgresExecutionQueue.claim(workerId, leaseSeconds)`, `heartbeat(...)`, and `finish(...)` call only the restricted SECURITY DEFINER queue functions.
- `runExecutionWorkerOnce(options)` claims at most one row, maintains its lease, enforces cancellation/timeout, invokes the runner once, and finalizes the same execution.

- [ ] Add RED unit tests for no-work, fake success, fake failure, cancellation, timeout, and abort/late-success precedence; add RED PostgreSQL test for expired-lease reclaim of the same execution id.
- [ ] Add the worker's restricted pg dependency/config without introducing a second DB privilege model.
- [ ] Implement queue adapter, fake runner, lease heartbeat, timeout AbortController, terminal-state precedence, and explicit fake-runner startup flag.
- [ ] Run worker + PostgreSQL tests GREEN.

### Task 4: Task page start, cancel, and polled status

**Files:**
- Create: `apps/web/components/task-execution-status.tsx`
- Create: `apps/web/app/api/tasks/[taskId]/execution/route.ts`
- Modify: `apps/web/app/tasks/[taskId]/page.tsx`
- Modify/add: `apps/web/tests/task-intake.test.ts` and focused execution UI tests.

**Interfaces:**
- Same-origin Next route proxies GET/start/cancel to the API while forwarding the tenant cookie; the browser never receives database/model credentials.
- Client component polls the same-origin execution endpoint while queued/running and exposes Start/Cancel only when the role/task ownership permits.

- [ ] Add RED tests for Start implementation on approved tasks, unauthorized-rep hiding, queued/running polling copy, Cancel control, and terminal failed/cancelled/timed-out messages.
- [ ] Implement the same-origin proxy and client status component; keep page titles/sections on signed-in scale.
- [ ] Run web tests and production Next build GREEN.

### Task 5: Full B1 verification and PR

- [ ] Run frozen install, lint, typecheck, full test suite against real PostgreSQL, Next production build, and LiteLLM hash-lock.
- [ ] Verify no live E2B/model call path is reachable from tests/CI and no secret/customer material is present.
- [ ] Review diff against B1 only; do not include B2 verification/patch logic, B3 publication, or B4 ZIP result promotion.
- [ ] Open one B1 PR. In its description list each covered failure state and exactly what the user sees, record exact head SHA and CI evidence, then stop for review without merging.

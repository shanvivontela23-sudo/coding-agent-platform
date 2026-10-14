# Per-project Decision Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist, reuse, and visibly manage tenant-scoped project knowledge derived from Dhara's existing verification and review outcomes.

**Architecture:** Migration 0014 establishes a forced-RLS append/supersede store. Shared pure utilities bound and serialize untrusted history; API and worker adapters use existing `withTenant()` transactions to read and write facts at their current lifecycle boundaries. The existing project and task pages expose history and plan rejection without adding a new service tier.

**Tech Stack:** TypeScript/NodeNext, PostgreSQL 16/RLS, Vitest, Node HTTP, Next.js/React.

**Spec:** `docs/superpowers/specs/2026-10-14-project-decision-log-design.md`

## Global Constraints

- Repository evidence beats project history; project history beats stack-skill defaults.
- History is untrusted user-message data, capped at 15 entries and 800 tokens/3,200 characters.
- Summaries are deterministic, PII-masked, non-empty, and no longer than 300 characters.
- No raw ticket text, arbitrary model memory, paid model calls, live E2B runs, template builds, or tests against `coding-agent-postgres`.
- Preserve forced RLS, composite tenant foreign keys, restricted runtime roles, `withTenant()`, exact-byte publication, and reproduce-first verification.

## Review Focus

- A cross-tenant project or decision id must remain invisible and unmodifiable.
- Repeated verification/publication/promotion callbacks must not create duplicate current memories.
- A command whose latest outcome changes must supersede the older outcome instead of showing contradictory current facts.
- History containing prompt-like text or PII must remain masked, bounded, and inside `<PROJECT_HISTORY>` user content.
- Non-owner users must never receive a working mutation path for project decisions.

---

### Task 1: Decision schema and pure history utilities

**Files:**
- Create: `packages/db/migrations/0014_project_decisions.sql`
- Modify: `packages/db/migrations/checksums.json`
- Create: `packages/db/src/project-decisions.ts`
- Modify: `packages/db/src/index.ts`
- Create: `packages/db/tests/project-decisions-contract.test.ts`
- Create: `packages/db/tests/project-decisions.test.ts`
- Create: `packages/db/tests/project-decision-format.test.ts`

**Interfaces:**
- Produces: `ProjectDecision`, `ProjectDecisionKind`, `ProjectDecisionSource`, `formatProjectHistory(decisions, options?)`, `normalizeDecisionSummary(value, mask)`.

- [ ] Write migration/formatter tests first; verify missing schema and exports fail.
- [ ] Add migration 0014, checksum, types, normalization, and bounded formatter.
- [ ] Run formatter and migration contract tests; run PostgreSQL test only when an explicitly disposable `TEST_DATABASE_URL` exists.
- [ ] Commit `feat: add tenant-scoped project decision store`.

### Task 2: API decision repository and owner management

**Files:**
- Create: `apps/api/src/project-decision-database.ts`
- Create: `apps/api/src/project-decision-service.ts`
- Create: `apps/api/src/project-decision-http.ts`
- Modify: `apps/api/src/main.ts`
- Modify: `apps/api/src/server.ts`
- Create: `apps/api/tests/project-decisions.test.ts`
- Create: `apps/api/tests/project-decision-http.test.ts`

**Interfaces:**
- Consumes: Task 1 types/formatting.
- Produces: `ProjectDecisionDatabase.listCurrent`, `.record`, `.supersede`; `ProjectDecisionService.list`, `.supersede`; project decision HTTP routes.

- [ ] Write failing repository/service/HTTP tests for newest-first reads, owner-only idempotent superseding, and tenant-scoped parameters.
- [ ] Implement the smallest database, service, and HTTP composition.
- [ ] Run API decision tests and adjacent server tests.
- [ ] Commit `feat: expose project decision history safely`.

### Task 3: Clarification and planning history

**Files:**
- Modify: `apps/api/src/task-intake.ts`
- Modify: `apps/api/src/task-service.ts`
- Modify: `apps/api/src/task-database.ts`
- Modify: `apps/api/tests/task-intake.test.ts`
- Create: `apps/api/tests/task-project-history.test.ts`

**Interfaces:**
- Consumes: `ProjectDecisionDatabase.listCurrent`, `formatProjectHistory`.
- Produces: `projectHistory` prompt input on clarification and planning.

- [ ] Write failing tests asserting `<PROJECT_HISTORY>` is only in user messages, remains bounded, and is loaded for create, retry, and plan.
- [ ] Add history inputs and database/service wiring while preserving existing trusted stack-guide placement.
- [ ] Run prompt, task-service, retry, and gateway tests.
- [ ] Commit `feat: include project history in task planning`.

### Task 4: Implementation history and verification facts

**Files:**
- Modify: `apps/worker/src/execution-source.ts`
- Modify: `apps/worker/src/product-execution-source.ts`
- Modify: `apps/worker/src/product-coding-runner.ts`
- Modify: `apps/worker/src/execution-store.ts`
- Modify: `apps/worker/tests/product-execution-source.test.ts`
- Modify: `apps/worker/tests/product-coding-runner.test.ts`
- Create: `apps/worker/tests/project-decision-verification.test.ts`

**Interfaces:**
- Consumes: Task 1 decision types/formatter.
- Produces: `PreparedExecutionSource.projectHistory`; verification-driven `command_worked`/`command_failed` writes with superseding.

- [ ] Write failing prompt/source/store tests, including outcome changes and retry idempotency.
- [ ] Load bounded history into execution source, render it as untrusted implementation context, and record verification facts transactionally.
- [ ] Run worker execution, coding-runner, and verification suites.
- [ ] Commit `feat: learn project commands from verification`.

### Task 5: Review outcome facts and plan rejection

**Files:**
- Modify: `apps/api/src/task-publication-database.ts`
- Modify: `apps/api/src/task-publication-service.ts`
- Modify: `apps/api/src/task-zip-result-database.ts`
- Modify: `apps/api/src/task-database.ts`
- Modify: `apps/api/src/task-service.ts`
- Modify: `apps/api/src/task-http.ts`
- Modify: `apps/api/tests/task-publication-service.test.ts`
- Modify: `apps/api/tests/task-zip-result-service.test.ts`
- Create: `apps/api/tests/task-plan-rejection.test.ts`

**Interfaces:**
- Consumes: deterministic decision writer.
- Produces: idempotent accepted outcome entries for PR publication/ZIP promotion and masked `reviewer_rejected` entries for plan rejection.

- [ ] Write failing tests for publication, promotion, masked reasons, authorization, and duplicate callbacks.
- [ ] Record outcomes in their existing tenant transactions and add requester-only plan rejection.
- [ ] Run publication, ZIP, and task workflow tests.
- [ ] Commit `feat: remember project review outcomes`.

### Task 6: Project learning panel and rejection controls

**Files:**
- Create: `apps/web/components/project-decisions.tsx`
- Modify: `apps/web/app/projects/[projectId]/page.tsx`
- Modify: `apps/web/app/tasks/[taskId]/page.tsx`
- Create: `apps/web/tests/project-decisions.test.ts`
- Modify: `apps/web/tests/task-intake.test.ts`

**Interfaces:**
- Consumes: Task 2 decision JSON and Task 5 rejection endpoint.
- Produces: readable learning panel, task links, owner-only “Mark as wrong”, and plan rejection form.

- [ ] Write failing rendering/source contract tests.
- [ ] Implement the accessible panel, empty state, owner control, and rejection form without redesigning adjacent UI.
- [ ] Run web tests and production build.
- [ ] Commit `feat: show what Dhara learned per project`.

### Task 7: Repository validation and PR handoff

**Files:**
- Modify: `docs/DEMO_RUNBOOK.md` only if migration/operator steps require clarification.

**Interfaces:**
- Consumes: Tasks 1–6.

- [ ] Run checksum/format checks, lint, typecheck, targeted suites, `pnpm test:parallel`, safe database tests when available, and web production build.
- [ ] Review the complete diff from `f86cf6fdbbd3879e43823b9be52b94fb3ae287cd` for RLS, tenant isolation, prompt trust, PII, idempotency, and API/UI contracts.
- [ ] Apply one TDD fix pass for Critical/Important review findings and rerun full validation.
- [ ] Push `codex/project-decision-log` and open a PR against `main`; do not merge.

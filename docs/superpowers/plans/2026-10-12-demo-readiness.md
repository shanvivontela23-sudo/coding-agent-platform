# Demo Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Dhara demo-ready on a Mac with one command, deterministic preflight checks, visible demo spend caps, and an operator runbook, without making paid calls during development or CI.

**Architecture:** Add an `apps/demo` orchestration package that reads the git-ignored root `.env`, validates configuration without echoing secret values, verifies/applies numbered migrations by checksum/order, starts the local LiteLLM/gateway Compose stack plus ngrok, and launches API:3101, web:3000, and the real worker. Preflight checks are explicit and individually testable; the product API exposes configured planning/execution caps to the existing execution read response so the signed-in task page can show them before Start.

**Tech Stack:** TypeScript, Node.js 22, pnpm, Docker Compose, psql, ngrok, PostgreSQL, existing E2B/GitHub/Supabase integrations, Next.js.

**Spec:** Approved PR-2 demo-readiness scope from 2026-10-12.

## Global Constraints

- Applied migrations `0006`–`0011` are immutable and must not be edited.
- No paid model calls, E2B sandbox creation, or live implementation execution in development/tests/CI.
- One Mac command starts/checks the demo dependencies and product processes.
- Root `.env` is git-ignored; output may name missing variables but must never print secret values.
- API owner port is `3101`; web port is `3000`.
- Demo default caps are `$1.00` per planning run and `$2.00` per implementation execution.
- GET/polling remains read-only.

## Review Focus

- Existing local database: migrations are not re-applied blindly; checksum/order drift fails before startup.
- Bad/missing secrets: diagnostics list variable names only, never values.
- E2B preflight authenticates by listing only and never creates a sandbox.
- Worker claim preflight runs in a rollback transaction so it cannot consume a queued execution.
- ngrok discovery must select the HTTPS tunnel for the local gateway and never expose a credential in logs.

---

### Task 1: Demo configuration and migration plan

**Files:**
- Create: `apps/demo/src/config.ts`
- Create: `apps/demo/src/migrations.ts`
- Test: `apps/demo/tests/demo-config.test.ts`
- Test: `apps/demo/tests/demo-migrations.test.ts`

- [ ] Write failing tests for `.env` parsing, exact missing-variable names, secret-safe summaries, demo defaults, ordered migration manifest validation, and checksum drift rejection.
- [ ] Run tests/typecheck and confirm RED because demo modules do not exist.
- [ ] Implement the minimal config/migration helpers.
- [ ] Run focused tests green.

### Task 2: Preflight boundary

**Files:**
- Create: `apps/demo/src/preflight.ts`
- Test: `apps/demo/tests/demo-preflight.test.ts`

- [ ] Write failing tests for named checks: database roles/migrations, Supabase, GitHub Contents write, E2B list-only auth, LiteLLM, tunnel, gateway token mint/verify, and rollback worker-claim dry run.
- [ ] Implement injectable check functions so CI uses fakes and no external/paid calls.
- [ ] Verify no check creates an E2B sandbox or claims work durably.

### Task 3: One-command launcher

**Files:**
- Create: `apps/demo/src/cli.ts`
- Create: `apps/demo/package.json`
- Modify: `package.json`
- Modify: `tsconfig.json`
- Modify: `.env.example`
- Test: `apps/demo/tests/demo-launcher.test.ts`

- [ ] Write failing launcher contract tests for ports, real worker mode, Compose, ngrok, exact missing vars, and secret-free command/log rendering.
- [ ] Implement startup ordering: config -> migrations -> Compose -> ngrok -> preflight -> API/web/real worker.
- [ ] Add graceful shutdown for child processes and Compose.
- [ ] Verify focused tests green.

### Task 4: Demo spend caps visible before Start

**Files:**
- Create: `apps/api/src/demo-budget-caps.ts`
- Modify: `apps/api/src/main.ts`
- Modify: `apps/api/src/task-execution-server.ts`
- Modify: `apps/web/components/task-execution-status.tsx`
- Test: `apps/api/tests/demo-budget-caps.test.ts`
- Test: `apps/web/tests/demo-budget-caps.test.ts`

- [ ] Write failing tests pinning defaults of planning `$1.00` and execution `$2.00`, API read payload, and pre-Start UI copy.
- [ ] Parse caps once in API composition and use the same values for task planning/execution budgets and the read payload.
- [ ] Render both caps before Start; do not change paid execution behavior beyond the configured caps.

### Task 5: Operator runbook and whole-branch verification

**Files:**
- Create: `docs/DEMO_RUNBOOK.md`

- [ ] Document `.env` setup, one-command startup, preflight output, public GitHub repo demo, refund-service ZIP bug demo, expected maximum/default-budget cost, screenshots/screens to capture, publication/promotion checkpoints, and shutdown.
- [ ] Run full CI-equivalent checks with no paid calls.
- [ ] Verify `0006`–`0011` unchanged against main and record exact-head evidence in the PR.

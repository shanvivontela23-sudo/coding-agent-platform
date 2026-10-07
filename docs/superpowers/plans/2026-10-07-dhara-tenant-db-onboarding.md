# Dhara Tenant DB Boundary and Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the next Dhara slice with a restricted PostgreSQL tenant boundary, first-run organization onboarding, signed-in home UI, safer cookies/errors, and eval sandbox accounting.

**Architecture:** The API connects as `coding_agent_api`, while tenant queries execute only inside a transaction that switches locally to `coding_agent_app` and sets `app.organization_id` through bound `set_config`. Login and onboarding are the only SECURITY DEFINER operations. Product UI consumes small auth/home/onboarding API routes. Eval accounting meters sandbox lifetimes without live provider calls.

**Tech Stack:** Node 22, TypeScript, PostgreSQL 16+, pg, Next.js 16, React 19, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-07-dhara-tenant-db-onboarding-design.md`

## Global Constraints

- Working product name is `Dhara`, held in one config constant only.
- Do not rename repository, packages, database objects, or environment variables.
- No API runtime connection as postgres/superuser.
- No Supabase-user-id RLS policy for onboarding.
- `withTenant` validates UUID then uses bound `SELECT set_config('app.organization_id', $1, true)`.
- No paid calls.

## Review Focus

- A failed tenant transaction must release a pooled connection with no leaked role or tenant setting.
- SECURITY DEFINER functions must use fixed search paths, fully qualified tables, and narrow EXECUTE grants.
- Onboarding must refuse users who already have any membership and cannot target an existing organization.
- HTTPS detection must set Secure on every auth/session-related cookie without breaking HTTP localhost.
- Sandbox time/cost must include both coding and evaluator lifetimes exactly once.

---

### Task 1: PostgreSQL roles and privileged functions

**Files:**
- Modify: `packages/db/migrations/0001_tenant_core.sql`
- Modify: `packages/db/tests/tenant-rls.test.ts`
- Modify: `packages/db/src/tenant-isolation-probe.ts`

**Interfaces:**
- Produces: `coding_agent_api` login role; `lookup_memberships_for_supabase_user(uuid)`; `create_organization_with_owner(uuid,text,text)`.

- [ ] Add failing PostgreSQL tests for role attributes/grants, membership lookup isolation, onboarding validation/refusal, and inability to attach to an existing organization.
- [ ] Run DB tests and confirm RED.
- [ ] Implement roles/functions with fixed search paths, fully qualified names, revoked PUBLIC execute, API-only execute.
- [ ] Run DB tests and confirm GREEN.

### Task 2: Tenant database access layer

**Files:**
- Create: `apps/api/src/database.ts`
- Create: `apps/api/tests/database.test.ts`
- Modify: `apps/api/src/membership.ts`

**Interfaces:**
- Produces: `withTenant(pool, session, callback)`, restricted membership lookup, onboarding function caller.

- [ ] Add RED tests for UUID validation, exact bound `set_config`, rollback/release, and role/setting cleanup.
- [ ] Implement `withTenant` using acquired pg client, BEGIN, SET LOCAL ROLE, parameterized set_config, COMMIT/ROLLBACK, release.
- [ ] Replace direct membership table query with SECURITY DEFINER function call.
- [ ] Run API DB tests GREEN.

### Task 3: Auth/onboarding/home API

**Files:**
- Modify: `apps/api/src/auth.ts`
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/src/main.ts`
- Modify: `apps/api/tests/server.test.ts`
- Create: `apps/api/tests/tenant-api.integration.test.ts`

**Interfaces:**
- Consumes: Task 2 database helpers.
- Produces: onboarding cookie/route, `/api/home`, sign-out, sanitized login redirects.

- [ ] Add RED tests for zero-membership onboarding, organization creation, home route, Secure cookies on HTTPS, readable error redirect, sign-out.
- [ ] Add real PostgreSQL integration RED test proving tenant-A API session cannot read tenant-B projects.
- [ ] Implement routes and session/onboarding flow.
- [ ] Start API in integration test with restricted login role and make tests GREEN.

### Task 4: Dhara web experience

**Files:**
- Create: `apps/web/src/product-config.ts`
- Modify: `apps/web/app/layout.tsx`
- Modify: `apps/web/app/page.tsx`
- Create: `apps/web/app/onboarding/page.tsx`
- Create: `apps/web/app/home/page.tsx`
- Modify/Create tests under `apps/web/tests/`

**Interfaces:**
- Produces: single `PRODUCT_NAME = "Dhara"` constant used by titles/login/home.

- [ ] Add RED render/source tests for Dhara naming, readable login errors, onboarding form, home org/project empty state/sign-out.
- [ ] Implement pages and metadata using one config constant.
- [ ] Run web tests and Next build GREEN.

### Task 5: Local restricted-role runbook

**Files:**
- Modify: `README.md`

- [ ] Add exact administrator schema/role setup and restricted `coding_agent_api` DATABASE_URL commands.
- [ ] Assert README no longer documents API runtime as postgres.

### Task 6: Eval sandbox accounting

**Files:**
- Modify: `evals/src/operator/single-task-spec.ts`
- Modify: `evals/src/operator/single-claude-task-cli.ts`
- Create/modify eval tests for sandbox accounting.

**Interfaces:**
- Produces: deterministic `sandboxSeconds`, `sandboxCostUsd`, and corrected `totalCostUsd` in final result row.

- [ ] Add RED tests with fake clock/lifecycle durations for coding + evaluator sandboxes.
- [ ] Add explicit `sandboxUsdPerSecond` task-spec input and meter both sandbox lifetimes.
- [ ] Run eval tests GREEN with no live calls.

### Task 7: Full verification and PR

- [ ] Run frozen install, lint, typecheck, full tests with real PostgreSQL, Next production build, LiteLLM hash-lock.
- [ ] Review changed-file scope and security invariants.
- [ ] Open one PR, record exact head/run evidence, stop for review.

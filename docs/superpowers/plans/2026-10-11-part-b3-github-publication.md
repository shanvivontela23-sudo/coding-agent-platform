# Part B3 GitHub Publication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish verified GitHub execution results from the control plane as an idempotent pull request without re-running paid coding, while blocking spend before GitHub write permission/readiness problems.

**Architecture:** Keep implementation execution and publication separate. The API performs a no-spend Start preflight against stored project-report readiness and the GitHub App installation permission, then B3 stores publication attempts durably in PostgreSQL and invokes a server-side GitHub publisher that branches from the approved SHA, checks plan/patch-file drift against current default-branch head, applies the persisted safe patch, and creates-or-adopts a pull request. Publication retries reuse the existing execution patch/change note and never invoke the worker/model.

**Tech Stack:** TypeScript, Node API, PostgreSQL/RLS, GitHub App REST/Git Data APIs, Next.js/Tailwind web, Vitest, pnpm.

**Spec:** `docs/superpowers/specs/2026-10-09-part-b-task-execution-delivery-design.md`

## Global Constraints

- Base is `eb6de0a296dc32e317e1bea69e499e36b687b048`.
- Applied migrations `0006`, `0007`, and `0008` are immutable; B3 adds only new migration(s), starting with `0009`.
- GitHub App repository permission required before paid execution: **Contents: Read and write**.
- Publication is control-plane-only and only after `succeeded`, or after `fix_not_reproduced` when a developer/owner explicitly publishes it; the PR must label that result unproven.
- Never publish `verification_failed` or `verification_incomplete` executions.
- Deterministic branch per execution; create-or-adopt after restart; never force-push; never merge.
- Branch from approved SHA. Default-branch movement alone does not block. Block `source_changed` only if a file named in the approved plan or patch changed between approved SHA and current head; otherwise record commit distance.
- PR body is the stored sanitized change note; no raw ticket, PII, transcripts, or secrets.
- Publication failures are retryable without a new execution/model run.
- Dependency-install failure detail is sanitized with the change-note sanitizer and bounded to the last 2,000 characters before storage/display.
- Legacy project reports without an `installCommand` field block Start with exact copy: **Re-analyse this project before implementation**.
- CI uses fake GitHub publication and never makes live GitHub writes, paid model calls, or E2B calls.
- Stop for review after the B3 PR; do not merge automatically.

## Review Focus

- Existing branch with the deterministic name but unexpected ancestry/content must not be force-pushed or silently overwritten; publication fails safely.
- Restart after branch creation but before PR creation must adopt the exact execution branch and create/adopt one PR without duplicate paid work.
- A moved default branch that changes unrelated files must still publish from the approved SHA and record the distance.
- A `fix_not_reproduced` execution must require explicit developer/owner publication and surface **unproven** in the PR body/title metadata without mutating the stored change note.
- Failure text from package registries must not persist credentials/tokens even when the sensitive data appears near the end of a long stderr string.

---

### Task 1: Start preflight and bounded sanitization

**Files:**
- Modify: `apps/worker/src/change-document.ts`
- Modify: `apps/worker/src/verification.ts`
- Modify: `apps/worker/src/product-execution-orchestrator.ts`
- Modify: `apps/api/src/github-app.ts`
- Modify: `apps/api/src/task-execution-database.ts`
- Modify: `apps/api/src/task-execution-service.ts`
- Modify: `apps/api/src/main.ts`
- Modify task-page execution data/UI files as required by current routing
- Test: worker sanitizer/install-failure tests
- Test: API Start preflight tests
- Test: web task-page readiness copy test

**Interfaces:**
- Produces `sanitizeChangeNoteText(value: string): string` reusable by failure detail and change-note rendering.
- Produces a bounded failure-detail helper that keeps at most the last 2,000 sanitized characters.
- Produces GitHub installation permission read returning whether repository `contents` permission is `write`.
- Produces execution Start readiness context that distinguishes a legacy report missing the `installCommand` property from a current report whose `installCommand` is explicitly `null`.

- [ ] Write failing tests for registry stderr containing a credential-bearing URL/token/auth header and verify stored failure/change-note detail is redacted and <= 2,000 characters.
- [ ] Run focused worker tests and confirm RED for missing reusable sanitizer/bounding.
- [ ] Implement reusable sanitizer + bounded install failure detail and route dependency-install failure through it.
- [ ] Run focused worker tests GREEN.
- [ ] Write failing API/web tests: legacy report missing `installCommand` blocks Start with `Re-analyse this project before implementation`; GitHub installation without Contents write blocks Start before an execution row is created and tells the owner to add `Contents: Read and write`; current report with explicit `installCommand: null` is not misclassified as legacy.
- [ ] Run focused API/web tests and confirm RED.
- [ ] Implement Start preflight and task-page readiness copy, with GitHub permission check occurring before queue insertion/model spend.
- [ ] Run focused tests GREEN.

### Task 2: Durable B3 publication contract

**Files:**
- Create: `packages/db/migrations/0009_github_publication.sql`
- Modify: `packages/db/migrations/checksums.json`
- Create/modify API publication database/service/server modules
- Test: PostgreSQL publication contract/integration tests

**Interfaces:**
- Publication record keyed by `(organization_id, execution_id)` with deterministic branch name, status, base/current head SHAs, base-moved commit count, PR number/URL, retryable failure code/message, timestamps, and publishing actor.
- API permits only developer/owner publication.
- Execution eligibility is exactly `succeeded` or explicit `fix_not_reproduced`; `verification_failed` and `verification_incomplete` are rejected.

- [ ] Write failing migration/database tests for publication uniqueness, tenant/RLS boundaries, immutable execution link, role authorization, eligible statuses, and retryable failed publication state.
- [ ] Run serial PostgreSQL tests and confirm RED because `0009`/publication API does not exist.
- [ ] Add `0009` and publication database/service contracts; keep `0006`–`0008` byte-identical.
- [ ] Run serial PostgreSQL tests GREEN.

### Task 3: Control-plane GitHub publisher, drift, and idempotence

**Files:**
- Create: `apps/api/src/github-publication.ts`
- Modify GitHub App client only as required for control-plane token/API operations
- Add focused fake publisher / fake GitHub REST tests

**Interfaces:**
- `GitHubPublisher.publish(input)` consumes repository/installation, approved SHA, current default branch, persisted patch, approved plan, stored change note, deterministic execution branch, and unproven flag.
- Returns adopted/created branch + PR identity and commit distance, or typed `source_changed` / retryable publication failure.

- [ ] Write failing tests for deterministic branch naming, approved-SHA branching, unrelated default-branch movement + commit-distance record, plan-file drift, patch-file drift, restart adoption, existing conflicting branch refusal, one PR only, no force-push, and stored change note as PR body.
- [ ] Confirm RED with fake GitHub transport only.
- [ ] Implement drift extraction from approved-plan file paths plus patch paths, compare approved SHA/current head, create-or-adopt deterministic branch, apply the persisted patch on the control plane, create-or-adopt PR, and mark `fix_not_reproduced` publication as unproven without exposing raw task content.
- [ ] Run focused publisher tests GREEN.

### Task 4: Publication endpoint and task-page UX

**Files:**
- Modify API task-execution publication routing/composition
- Modify `apps/web/components/task-execution-status.tsx` and task page wiring
- Test: API HTTP integration and web source/render tests

**Interfaces:**
- `POST /api/tasks/:taskId/execution/publication` publishes/retries the latest eligible GitHub execution.
- `GET` execution response exposes publication status/PR URL/commit distance and whether current user can publish.

- [ ] Write failing HTTP/web tests for developer/owner Publish, rep rejection, explicit unproven publish, no publish button for verification failure/incomplete, retry after publication failure without a new execution, source_changed copy, PR link, and base-moved commit count.
- [ ] Confirm RED.
- [ ] Wire service/publisher/database and web controls; no merge action exists.
- [ ] Run focused tests GREEN.

### Task 5: Full verification and review handoff

**Files:**
- Update: `docs/superpowers/specs/2026-10-09-part-b-task-execution-delivery-design.md` only if needed to record the two explicit B3 review additions; do not alter approved behavioral meaning.
- Update B3 PR description.

- [ ] Verify `0006`, `0007`, `0008` blob SHAs match `main` exactly.
- [ ] Run `pnpm lint`.
- [ ] Run `pnpm typecheck`.
- [ ] Run full `pnpm test` including serial PostgreSQL integration.
- [ ] Run `pnpm --filter @coding-agent/web build`.
- [ ] Verify LiteLLM hash lock via normal CI.
- [ ] Confirm tests use fake GitHub publication and no live GitHub write/paid model/E2B call occurred.
- [ ] Update PR body with failure states, user-visible behavior, exact GitHub App permission change (**Contents: Read and write**), RED/GREEN evidence, exact head SHA/CI, and explicit no-auto-merge/no-live-write statement.
- [ ] Mark PR ready for review and stop. Do not start B4.

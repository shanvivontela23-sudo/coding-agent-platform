# Dhara GitHub Project Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect a verified GitHub App installation to a Dhara tenant, create a project from a selected repository, and persist/render a deterministic repository report without any model call.

**Architecture:** A focused server-side GitHub App client owns OAuth/app/installation token exchanges; PostgreSQL owns single-use state and unique installation binding; a shared pure TypeScript analyzer owns deterministic repository detection. The browser sees only signed state, repository metadata, and persisted report data—never GitHub tokens.

**Tech Stack:** TypeScript/Node 22, built-in `fetch` and `node:crypto`, PostgreSQL 16/RLS, Next.js 16, Vitest, pnpm.

**Spec:** `docs/superpowers/specs/2026-10-07-dhara-github-project-report-design.md` and PR #20 design note.

## Global Constraints

- One implementation PR; stop ready for review and do not merge.
- No model or paid AI calls in project analysis.
- Owner/developer may connect; rep may not.
- GitHub user/access/installation tokens are server-only, ephemeral, unpersisted, unreturned, and unlogged.
- Existing migrations `0001` and `0002` remain byte-identical.
- GitHub installation binding is verified via OAuth user access plus GitHub API, never trusted from callback query parameters.
- Signed installation state is tenant/user-bound, ten-minute expiry, DB-backed, and single-use.
- Project report is deterministic and persisted with the analyzed full 40-character commit SHA.
- Known API failures use typed short safe codes; unknowns log only `internal_error`.
- Signed-in headings max at `text-2xl`; card titles are `text-base`; How-it-works titles are medium weight.

## Review Focus

- Callback missing `installation_id`: bind only one unambiguous accessible installation; otherwise fail closed.
- Repository selected in browser but removed from installation before submit: re-fetch by id with installation token and reject instead of trusting submitted metadata.
- Multiple lockfiles/manifests: deterministic precedence and stable analyzer output.
- GitHub token/provider error values containing secrets: typed wrappers must replace them before logging/response.
- Reconnect/race conditions: state consume and installation uniqueness remain correct under concurrent callbacks.

---

### Task 1: Review follow-up hardening

**Files:**
- Modify: `apps/api/src/auth.ts`
- Create: `apps/api/src/errors.ts`
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/src/database.ts`
- Modify tests: `apps/api/tests/auth.test.ts`, `apps/api/tests/error-logging.test.ts`, `apps/api/tests/database.test.ts`
- Replace test: `packages/db/tests/migration-immutability.test.ts`
- Create later with migration: `packages/db/migrations/checksums.json`

**Interfaces:**
- Produces: `ApiError(code: ApiErrorCode, status?: number)` and `safeErrorCode(error): string`.
- Produces owner-only `MembersData.invitations` semantics.

- [ ] Write failing tests proving `confirmed_at` alone does not set `emailConfirmed`, non-owner members receive no pending invites, logging contains `code` and no raw message, and migration test requires an exact checksum manifest.
- [ ] Run focused tests; verify failures are caused by current behavior/missing manifest.
- [ ] Implement email-confirmation fix, typed safe errors/logger, owner-only invite query/response, and manifest-based migration check.
- [ ] Run focused tests and full suite; keep green before next task.

### Task 2: Shared deterministic repository analyzer

**Files:**
- Create: `packages/project-analysis/index.ts`
- Create: `packages/project-analysis/index.test.ts`
- Modify: `evals/src/domain/run-result.ts` only if a shared exported stack type can replace duplicated literals without changing existing schema behavior.

**Interfaces:**
- Produces:
  - `RepositoryTreeEntry { path: string; type: "blob" | "tree"; size?: number }`
  - `RepositorySnapshot { tree: readonly RepositoryTreeEntry[]; files: Readonly<Record<string,string>> }`
  - `ProjectReport { languages; frameworks; packageManager; buildCommand; testCommand; stackSkill }`
  - `analyzeProject(snapshot: RepositorySnapshot): ProjectReport`
  - `analysisManifestPaths(tree): string[]` so GitHub fetching and analysis use one manifest allowlist.

- [ ] Write fixture tests for pnpm/Next TypeScript, Python/FastAPI/pytest, Maven Spring, .NET Web, generic fallback, ignored generated directories, stable language sorting/share, and multiple-lockfile precedence.
- [ ] Run analyzer tests; verify module/API is absent.
- [ ] Implement pure deterministic analyzer with no network/model imports.
- [ ] Run analyzer tests and full suite.

### Task 3: Database migration for GitHub installation/state/report persistence

**Files:**
- Create: `packages/db/migrations/0003_github_projects.sql`
- Update: `packages/db/migrations/checksums.json`
- Create/modify: `packages/db/tests/github-projects.test.ts`
- Modify: `packages/db/src/tenant-isolation-probe.ts` only if the probe enumerates schema tables/functions that must include the new objects.

**Interfaces:**
- Tables: `github_installations`, `github_installation_states`; repository analysis columns.
- Database guarantees: one installation/org, globally unique `installation_id`, state tied to `(organization_id,user_id)`, consumed once, RLS tenant scope, full SHA/report constraints.

- [ ] Write PostgreSQL tests for owner/developer state creation eligibility where relevant, cross-tenant installation uniqueness, state consume/replay, RLS isolation, and repository report persistence.
- [ ] Run DB test against CI PostgreSQL; verify RED due missing migration.
- [ ] Implement `0003` only; do not edit `0001`/`0002`.
- [ ] Compute SHA-256 for `0001`, `0002`, `0003`; update exact manifest.
- [ ] Run DB + migration-immutability tests and full suite.

### Task 4: Product database operations

**Files:**
- Modify: `apps/api/src/database.ts`
- Modify/create tests: `apps/api/tests/database.test.ts`, `apps/api/tests/github-database.test.ts`

**Interfaces:**
- Produces role lookup/authorization for current member.
- Produces `createGitHubInstallState(session, expiresAt)`, `consumeGitHubInstallState(session, stateId)`, `bindGitHubInstallation(session, installationId)`, `getGitHubInstallation(session)`, `createProjectFromRepository(session, input)`, `getProject(session, projectId)`.

- [ ] Write failing unit tests for SQL calls and returned shapes, especially atomic consume and cross-org conflict mapping.
- [ ] Run focused tests; verify RED.
- [ ] Implement minimal tenant-scoped operations with typed errors.
- [ ] Run focused tests and full suite.

### Task 5: GitHub App cryptography and API client

**Files:**
- Create: `apps/api/src/github-app.ts`
- Create: `apps/api/tests/github-app.test.ts`

**Interfaces:**
- Produces `GitHubAppClient` with:
  - `installationUrl(state: string): string`
  - `exchangeUserCode(code: string): Promise<string>` (token remains internal to server call flow)
  - `listUserInstallations(userToken: string): Promise<readonly number[]>`
  - `mintInstallationToken(installationId: number): Promise<string>`
  - `listInstallationRepositories(installationToken): Promise<RepositorySummary[]>`
  - `loadRepositorySnapshot(installationToken, repositoryId): Promise<AnalyzedRepositorySource>`
- Produces signed install state helpers tied to session identity and expiry.

- [ ] Write tests for RS256 JWT claims, state signature/mismatch/expiry, OAuth exchange, verified user installations, installation token request, repository pagination/lookup/tree/manifest reads, and secret-free typed failures.
- [ ] Run tests; verify RED.
- [ ] Implement with built-in crypto/fetch; set GitHub REST API version header.
- [ ] Run focused tests and full suite.

### Task 6: GitHub installation callback and repository/project API flows

**Files:**
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/src/main.ts`
- Create: `apps/api/tests/github-flow.test.ts`
- Modify: `apps/api/tests/error-logging.test.ts`

**Interfaces:**
- Routes:
  - `GET /github/install/start`
  - `GET /github/callback`
  - `GET /api/github/repositories`
  - `POST /projects`
  - `GET /api/projects/:id`

- [ ] Write failing end-to-end server tests: owner/developer start succeeds, rep denied; forged installation id rejected; replayed state rejected; other-org installation rejected; missing id accepts only one unambiguous verified candidate; repository response has no token; project POST re-fetches repository id and persists analyzer result; project GET is tenant-scoped.
- [ ] Run focused tests; verify RED.
- [ ] Wire the routes using Task 4/5 interfaces. Ensure OAuth user token scope ends before redirect and installation token scope ends per request.
- [ ] Run focused tests and full suite.

### Task 7: Signed-in web flow and navigation fixes

**Files:**
- Modify: `apps/web/app/home/page.tsx`
- Modify: `apps/web/components/app-shell.tsx`
- Create: `apps/web/components/app-navigation.tsx`
- Create: `apps/web/app/connect/github/page.tsx`
- Create: `apps/web/app/projects/[id]/page.tsx`
- Modify/create tests: `apps/web/tests/signed-in-pages.test.ts`, `apps/web/tests/web-polish-theme.test.ts`, `apps/web/tests/github-project-flow.test.ts`

**Interfaces:**
- Web reads repository/project JSON from Task 6 routes with tenant cookies.
- `AppNavigation` derives active state from pathname.

- [ ] Write failing source/behavior tests for live Connect action, no disabled primary actions, no Tasks/Settings, active/inactive nav classes, 16px medium How-it-works titles, heading size ceiling, repository picker, and project report fields.
- [ ] Run web tests; verify RED.
- [ ] Implement pages/navigation with existing semantic tokens and AppShell.
- [ ] Run web tests and production `next build`.

### Task 8: GitHub App operator documentation and environment contract

**Files:**
- Modify: `README.md`
- Modify: `.env.example`
- Create: `apps/api/tests/github-config.test.ts` or source-contract test.

**Interfaces:**
- Runtime environment: `GITHUB_APP_SLUG`, `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_STATE_SECRET`.

- [ ] Write failing test asserting exact permission/settings/env documentation and future Contents write note.
- [ ] Run test; verify RED.
- [ ] Document local callback URL `${API_ORIGIN}/github/callback`, user authorization on, webhook off, current permissions, env loading/newline handling for PEM, and later Contents write requirement.
- [ ] Run focused test and full suite.

### Task 9: Whole-branch security review and release gate

**Files:** PR #20 description only unless review identifies a defect.

- [ ] Inspect final changed-file list/patch for token persistence/logging, callback trust, tenant boundaries, model/gateway imports in analysis, migration edits, and disabled primary actions.
- [ ] Run exact-head CI and require: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm --filter @coding-agent/web build`, LiteLLM hash lock all pass.
- [ ] Record exact head SHA and test counts in PR description.
- [ ] Mark PR ready for review and stop. Do not merge.
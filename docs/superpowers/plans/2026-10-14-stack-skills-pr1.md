# Stack Skills PR 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a versioned TypeScript/Node stack skill that is detected from repository evidence, safely enriches planning and implementation, pins one execution profile and sandbox template per run, and improves verification without breaking old project reports.

**Architecture:** A source-only `packages/skills/` module owns strict built-in skill loading, evidence-based resolution, prompt fragments, template-key resolution, and safe focused-test command construction. The API uses it while analysing repositories and producing plans; migration `0013` records accepted planning metadata and an immutable worker execution profile; the worker pins that profile before any sandbox or model work and passes it unchanged to coding and both verification sandboxes. Existing report JSON and generic execution remain valid fallbacks.

**Tech Stack:** TypeScript, Node.js ESM/NodeNext, Zod, Vitest, PostgreSQL migrations/RLS, React/Next.js, pnpm.

**Design spec:** [`docs/superpowers/specs/2026-10-14-stack-skills-pr1-design.md`](../specs/2026-10-14-stack-skills-pr1-design.md)

## Global constraints

- Base is exactly `a7b9841db1b086f4ad8863b964ff20b7227875f5`; work only on `feat/stack-skills-pr1` in the managed worktree.
- Do not edit migrations `0001` through `0012`, build an E2B template, make paid model/E2B calls, merge, or run `pnpm test:postgres` against the local demo database.
- Preserve ESM `.js` import specifiers, PII masking, encrypted tickets, untrusted prompt wrappers, tenant scoping, restricted worker-role behavior, spend controls, reproduce-first proof, exact verified-byte publication, and no-auto-merge behavior.
- A missing skill, legacy report, absent keyed template setting, or unconfigured skill template must fall back to generic behavior and `E2B_TEMPLATE_ID`; malformed built-ins must fail API and worker startup.
- Repository-derived commands always win. Skill commands require positive repository evidence. Lint is an implementation hint only; verification stays install → test → build.
- Use `apply_patch` for edits. Make the commits named below only after the targeted tests pass. Never weaken a test to obtain green output.

## Review focus

Every task that touches these boundaries must include the named regression test:

1. **Invented commands:** no test/build default without a script or detected tool/runner.
2. **Wrong focused runner:** `testSingle` is selected only for detected Vitest/Jest/Mocha/node:test; unknown runner preserves the existing full-test fallback.
3. **Profile drift:** implementation, baseline, and patched verification use the one persisted skill version, command set, guide snapshot, and template id even if env or built-ins change later.
4. **Failure laundering:** baseline-pass plus patched-only `Cannot find module` is a code failure; only a matching baseline environment condition can produce `verification_incomplete` for test/build.
5. **Shell injection:** patch-derived paths with traversal, absolute form, NUL, CR/LF are rejected; spaces, quotes, and semicolons are one safely quoted shell argument.

## Execution prerequisite: establish the isolated baseline

- [ ] Confirm `git status --short --branch`, `git rev-parse HEAD`, and `git merge-base HEAD origin/main`; expect branch `feat/stack-skills-pr1`, the two design commits on top of the approved base, and no product-code changes.
- [ ] Run `pnpm install --frozen-lockfile`; expect lockfile validation and dependency setup to pass without changing `pnpm-lock.yaml`.
- [ ] Run `pnpm test:parallel`; expect the approved-base suite to pass before implementation. If it fails, use `superpowers:systematic-debugging`, record the pre-existing failure, and do not change product tests to hide it.

## Task 1: Build and validate the shared skill registry

**Files:**

- Create: `packages/skills/src/schema.ts`
- Create: `packages/skills/src/registry.ts`
- Create: `packages/skills/src/index.ts`
- Create: `packages/skills/stacks/typescript-node/skill.json`
- Create: `packages/skills/stacks/typescript-node/guide.md`
- Create: `packages/skills/tests/schema.test.ts`
- Create: `packages/skills/tests/registry.test.ts`

- [ ] Write failing schema tests for a valid TypeScript/Node skill and rejection of unknown keys, invalid ids/versions, empty commands, duplicate/invalid verification steps, malformed environment patterns, malformed or repeated `{path}`, non-positive limits, and a guide over the 1,500-token cap.
- [ ] Run `pnpm vitest run packages/skills/tests/schema.test.ts`; expect failure because the schema module and fixture do not exist.
- [ ] Implement strict Zod types for `StackSkill`, command roles, runner-specific `testSingle` templates, ordered verification definitions, positive limits, and the shared conservative UTF-8-byte token estimate.
- [ ] Add `skill.json` with `sandboxTemplateKey: "typescript-node"`, runner variants for `vitest`, `jest`, `mocha`, and `node:test`, install/test/build/lint hints, and verification entries containing only install/test/build.
- [ ] Add a bounded trusted `guide.md` covering TypeScript/Node package-manager discipline, runner-aware tests, build expectations, and minimal-change guidance without repository-derived content.
- [ ] Write failing registry tests proving every built-in loads, duplicate ids fail, errors identify the file/schema path without echoing guide contents, and loading still works after `process.chdir()` to a temporary directory.
- [ ] Run `pnpm vitest run packages/skills/tests/registry.test.ts`; expect failure because the registry is absent.
- [ ] Implement `loadBuiltInStackSkills()` using URLs derived from `import.meta.url`, validate JSON and guide pairs, enforce unique ids and id/version pairs, and export immutable lookup helpers.
- [ ] Run `pnpm vitest run packages/skills/tests/schema.test.ts packages/skills/tests/registry.test.ts`; expect pass.
- [ ] Commit with `git commit -am "feat: add validated stack skill registry"`, adding all new package files first.

## Task 2: Resolve skills and commands only from repository evidence

**Files:**

- Create: `packages/skills/src/resolution.ts`
- Modify: `packages/skills/src/index.ts`
- Modify: `apps/api/src/repository-analysis.ts`
- Modify: `apps/api/src/database.ts`
- Test: `packages/skills/tests/resolution.test.ts`
- Test: `apps/api/tests/repository-analysis.test.ts`
- Test: `apps/api/tests/report-hardening.test.ts`

- [ ] Write failing resolution tests for TypeScript/Node detection, generic fallback, each supported test runner, ambiguous/unknown runner, repo-over-skill precedence, evidence-gated defaults, null commands without evidence, lint-as-hint, and old reports containing only `stackSkill` plus legacy command fields.
- [ ] Run `pnpm vitest run packages/skills/tests/resolution.test.ts apps/api/tests/repository-analysis.test.ts apps/api/tests/report-hardening.test.ts`; expect the new cases to fail.
- [ ] Add optional backward-compatible `ProjectReport` fields: `stackSkillVersion`, `stackDisplayName`, `sandboxTemplateKey`, `commandSources`, `testRunner`, `testSingleCommand`, `lintCommand`, and ordered verification/limit metadata. Keep `stackSkill` a string and keep all existing fields readable.
- [ ] Extend repository analysis evidence with safe manifest paths, parsed package scripts/dependencies, package-manager markers, build-tool markers, and runner markers; do not retain arbitrary repository file contents in the report.
- [ ] Implement field-by-field resolution so stored/repository commands win, skill defaults require matching evidence, supported runner detection alone controls `testSingle`, and no test/build command is invented.
- [ ] Ensure `analyseRepositoryEntries()` writes enriched reports for new analysis while `ProjectReportData` and all report readers tolerate missing optional fields without re-analysis.
- [ ] Run `pnpm vitest run packages/skills/tests/resolution.test.ts apps/api/tests/repository-analysis.test.ts apps/api/tests/report-hardening.test.ts apps/api/tests/product-07-upload-archive.test.ts`; expect pass.
- [ ] Commit with `git commit -am "feat: resolve stack skills from repository evidence"`.

## Task 3: Add stable, bounded skill guidance to planning only

**Files:**

- Create: `packages/skills/src/prompt.ts`
- Modify: `packages/skills/src/index.ts`
- Modify: `apps/api/src/project-code-reader.ts`
- Modify: `apps/api/src/hybrid-project-code-reader.ts`
- Modify: `apps/api/src/task-intake.ts`
- Modify: `apps/api/src/task-service.ts`
- Test: `packages/skills/tests/prompt.test.ts`
- Test: `apps/api/tests/task-intake.test.ts`
- Test: `apps/api/tests/task-intake-job-type.test.ts`
- Test: `apps/api/tests/task-service.test.ts`
- Test: `apps/api/tests/task-plan-source-pin.test.ts`

- [ ] Write failing prompt tests asserting the clarification system message contains only the trusted stack display name and none of the guide, commands, runner details, or verification advice.
- [ ] Write failing plan-prompt tests asserting fixed safety text precedes the id/version and full guide, the output contract follows that stable skill prefix, all task-specific material remains in the existing untrusted user blocks, and the added prefix stays within the declared token cap.
- [ ] Run `pnpm vitest run packages/skills/tests/prompt.test.ts apps/api/tests/task-intake.test.ts apps/api/tests/task-intake-job-type.test.ts`; expect failure.
- [ ] Add a prompt helper returning separate `clarificationLabel` and `trustedGuidePrefix` values from a resolved current or legacy report, with an empty/generic guide when resolution cannot be trusted.
- [ ] Extend `ProjectCodeContext` to carry the stored project report alongside source revision/text, then update both GitHub and upload readers and their fakes without moving report data into the untrusted repository-context block.
- [ ] Change `buildClarificationPrompt()` to insert only a fixed stack-display sentence in the system message; keep behavior-only wording and all existing untrusted wrappers unchanged.
- [ ] Change `buildPlanPrompt()` to accept a trusted prefix and assemble fixed planner safety text → bounded guide/id/version → fixed output contract at a deterministic system-message location.
- [ ] Update `createTaskPlanningService()` so clarification and planning resolve from the context report; planning retries use the same rules and no guide is read from repository content.
- [ ] Run `pnpm vitest run packages/skills/tests/prompt.test.ts apps/api/tests/task-intake.test.ts apps/api/tests/task-intake-job-type.test.ts apps/api/tests/task-service.test.ts apps/api/tests/task-plan-source-pin.test.ts apps/api/tests/project-code-reader.test.ts`; expect pass.
- [ ] Commit with `git commit -am "feat: add stack guidance to planning prompts"`.

## Task 4: Add backward-compatible planning and execution-profile persistence

**Files:**

- Create: `packages/db/migrations/0013_stack_skill_execution_profile.sql`
- Modify: `packages/db/migrations/checksums.json`
- Create: `packages/db/tests/stack-skill-execution-profile-contract.test.ts`
- Create: `packages/db/tests/stack-skill-execution-profile.test.ts`
- Modify: `apps/api/src/task-database.ts`
- Modify: `apps/api/tests/task-plan-source-pin.test.ts`
- Modify: `apps/api/tests/task-service.test.ts`

- [ ] Write a failing migration-contract test requiring nullable `planning_skill_id` and `planning_skill_version` on `tasks`, nullable implementation/planning/template columns plus a JSONB execution-profile snapshot on `task_executions`, composite tenant-scoped access, no edits to old migration checksums, table-level `coding_agent_app` grants remaining sufficient, and no direct DML grant to `coding_agent_worker`.
- [ ] Run `pnpm vitest run packages/db/tests/stack-skill-execution-profile-contract.test.ts packages/db/tests/migration-immutability.test.ts`; expect failure because migration `0013` is missing.
- [ ] Add migration `0013` with nullable columns, JSON object/type checks sufficient to reject non-object snapshots, no relaxed RLS/policies, and no redundant column-level grant that changes the existing role model.
- [ ] Add the exact SHA-256 for `0013` to `checksums.json` without changing prior entries.
- [ ] Extend `TaskDatabase.savePlan()` to accept planning skill id/version and persist the accepted attempt atomically with the plan and source pin; generic resolution writes nulls rather than claiming a version.
- [ ] Add service/database unit tests proving planning retries overwrite the accepted planning metadata, old rows with null metadata still read, and no secret or guide snapshot is stored on `tasks`.
- [ ] Add a PostgreSQL integration test proving the API tenant role can update/read the new task and execution columns only within its organization, while `coding_agent_worker` still has no direct table access before its established tenant-role assumption. Mark it for the canonical postgres suite; do not run it against the demo database.
- [ ] Run `pnpm vitest run packages/db/tests/stack-skill-execution-profile-contract.test.ts packages/db/tests/migration-immutability.test.ts apps/api/tests/task-plan-source-pin.test.ts apps/api/tests/task-service.test.ts`; expect pass.
- [ ] Commit with `git commit -am "feat: persist stack skill measurement metadata"`.

## Task 5: Resolve and atomically pin one execution profile

**Files:**

- Modify: `packages/skills/src/resolution.ts`
- Modify: `packages/skills/src/index.ts`
- Modify: `apps/worker/src/worker-config.ts`
- Modify: `apps/worker/src/execution-source.ts`
- Modify: `apps/worker/src/product-execution-source.ts`
- Modify: `apps/worker/src/execution-store.ts`
- Modify: `apps/worker/src/product-execution-orchestrator.ts`
- Modify: `apps/worker/src/real-worker.ts`
- Modify: `.env.example`
- Modify: `docs/DEMO_RUNBOOK.md`
- Test: `apps/worker/tests/worker-config.test.ts`
- Test: `apps/worker/tests/product-execution-source.test.ts`
- Test: `apps/worker/tests/execution-store.test.ts`
- Test: `apps/worker/tests/product-execution-orchestrator.test.ts`
- Test: `apps/demo/tests/launcher.test.ts`

- [ ] Define `ResolvedExecutionProfile` with implementation and planning skill id/version, resolved install/test/build/lint commands and sources, runner/single-test template, ordered verification metadata/timeouts, bounded guide snapshot, and the final sandbox template id.
- [ ] Write failing config tests proving key `typescript-node` reads `E2B_TEMPLATE_TYPESCRIPT_NODE`, an unset/blank key falls back to required `E2B_TEMPLATE_ID`, a generic/legacy report also falls back, and no compare-and-swap/template-not-found retry exists.
- [ ] Write failing store/orchestrator tests proving `pinExecutionProfile(execution, candidate)` persists before `markSourcePrepared`, returns an existing stored profile on reclaim, ignores later environment/registry changes, and never starts a sandbox/model when persistence fails.
- [ ] Run `pnpm vitest run apps/worker/tests/worker-config.test.ts apps/worker/tests/execution-store.test.ts apps/worker/tests/product-execution-orchestrator.test.ts`; expect failure.
- [ ] Extend worker config with optional keyed template values while retaining `E2B_TEMPLATE_ID` as the required universal fallback; expose a pure key-to-env resolver that never logs ids or credentials.
- [ ] Add `E2B_TEMPLATE_TYPESCRIPT_NODE` as an optional commented `.env.example` entry. Document in `docs/DEMO_RUNBOOK.md` that an unset key falls back to `E2B_TEMPLATE_ID`, and that migration `0013` must be applied to an existing local database before `pnpm demo` because the launcher rejects partially migrated databases.
- [ ] Add a demo-launcher preflight test proving configuration with only `E2B_TEMPLATE_ID` still passes and a missing per-stack template key is never reported as a preflight failure.
- [ ] Make `ProductExecutionSourceProvider.prepare()` return repository/report facts needed for resolution but stop independently deciding mutable commands after a profile has been pinned.
- [ ] Implement tenant-scoped `PostgresExecutionStore.pinExecutionProfile()` as one atomic `UPDATE ... SET profile = COALESCE(profile, candidate) ... RETURNING` operation that validates/deserializes the returned snapshot and records queryable planning/implementation versions and template id consistently.
- [ ] Update the orchestrator to resolve a candidate once, pin/load it before `source_prepared_at`, and attach the stored profile to `PreparedExecutionSource` for every later stage.
- [ ] Change sandbox creation calls to pass `template: source.executionProfile.sandboxTemplateId`; retain the provider default only for unrelated legacy callers. Use the same stored id for coding, baseline, and patched verification.
- [ ] Run `pnpm vitest run apps/worker/tests/worker-config.test.ts apps/worker/tests/product-execution-source.test.ts apps/worker/tests/execution-store.test.ts apps/worker/tests/product-execution-orchestrator.test.ts apps/demo/tests/launcher.test.ts`; expect pass.
- [ ] Commit with `git commit -am "feat: pin stack execution profiles"`.

## Task 6: Safely enrich implementation prompts and focused tests

**Files:**

- Modify: `packages/skills/src/prompt.ts`
- Modify: `packages/skills/src/resolution.ts`
- Modify: `apps/worker/src/product-coding-runner.ts`
- Modify: `apps/worker/src/patch-parser.ts`
- Test: `packages/skills/tests/prompt.test.ts`
- Test: `apps/worker/tests/product-coding-runner.test.ts`
- Test: `apps/worker/tests/patch-parser.test.ts`

- [ ] Write failing prompt tests requiring a deterministic bounded implementation section containing guide id/version, available install/test/build/lint/focused-test hints, then the existing requirement/plan and reproduce-first instruction; assert no unavailable command is printed.
- [ ] Write failing focused-command tests for Vitest, Jest, Mocha, and node:test templates; unknown runner must append the safely quoted path to the pinned full test command exactly as current behavior does.
- [ ] Write failing hostile-path tests for absolute paths, any `..` segment after separator normalization, NUL, CR, LF, and workspace escape; write positive tests for spaces, single quotes, and semicolons producing one `shellArg`-quoted argument.
- [ ] Run `pnpm vitest run packages/skills/tests/prompt.test.ts apps/worker/tests/product-coding-runner.test.ts apps/worker/tests/patch-parser.test.ts`; expect failure.
- [ ] Export/reuse one path validator and `shellArg` helper; accept only normalized workspace-relative patch paths and substitute `{path}` exactly once after validation.
- [ ] Update reproduction-command selection to prefer the pinned runner template, then use the current full-test append fallback, then return null only when no safe command/path exists.
- [ ] Build coding task text from the pinned guide snapshot and pinned command hints. Keep lint in this text only; do not add it to verification metadata or run it automatically.
- [ ] Pass `template: source.executionProfile.sandboxTemplateId` in coding sandbox creation and assert the pinned value in the runner tests.
- [ ] Run `pnpm vitest run packages/skills/tests/prompt.test.ts apps/worker/tests/product-coding-runner.test.ts apps/worker/tests/patch-parser.test.ts`; expect pass.
- [ ] Commit with `git commit -am "feat: apply stack skills safely during coding"`.

## Task 7: Make verification profile-driven and baseline-anchor setup failures

**Files:**

- Modify: `apps/worker/src/verification.ts`
- Modify: `apps/worker/src/product-execution-orchestrator.ts`
- Modify: `apps/worker/src/change-document.ts`
- Test: `apps/worker/tests/b2-verification.test.ts`
- Test: `apps/worker/tests/b4-verification-order.test.ts`
- Test: `apps/worker/tests/verification-incomplete.test.ts`
- Test: `apps/worker/tests/verification-status-text.test.ts`

- [ ] Write failing verification tests that record exact command order as install → test → build in both baseline and patched sessions, prove lint is absent, and prove both sandboxes receive the same pinned template id.
- [ ] Add the two required classification regressions: baseline test passes plus patched `Cannot find module` yields `hasNewFailures: true`/code failure; both sides fail with the same missing-toolchain environment pattern yields `complete: false` and the orchestration result `verification_incomplete`.
- [ ] Add tests showing dependency-install failure is always setup failure, a skill-sourced baseline missing script/tool is setup failure, a repo-sourced ordinary assertion failure remains code evidence, and no environment pattern can turn a run into success or reproduce-first proof.
- [ ] Run `pnpm vitest run apps/worker/tests/b2-verification.test.ts apps/worker/tests/b4-verification-order.test.ts apps/worker/tests/verification-incomplete.test.ts apps/worker/tests/verification-status-text.test.ts`; expect failure.
- [ ] Drive check order and environment patterns from the pinned profile while allowing old/generic sources to synthesize the current install/test/build behavior.
- [ ] Classify setup separately from checks. For test/build, compare the baseline first; environment-like output only marks the run incomplete when the baseline exhibits the matching environment condition. Never classify a patched-only failure as environment.
- [ ] Preserve current failing-test-name comparison and assertion-style reproduce-first classification for code failures.
- [ ] Use non-blaming bounded wording (`Dhara couldn't set up the project for verification.` plus safe detail) without raw output, repository content, env values, or credentials.
- [ ] Run `pnpm vitest run apps/worker/tests/b2-verification.test.ts apps/worker/tests/b3-verified-files.test.ts apps/worker/tests/b4-verification-order.test.ts apps/worker/tests/verification-incomplete.test.ts apps/worker/tests/verification-status-text.test.ts apps/worker/tests/product-execution-orchestrator.test.ts`; expect pass.
- [ ] Commit with `git commit -am "fix: baseline-anchor skill verification failures"`.

## Task 8: Fail loudly on broken built-ins at both process entry points

**Files:**

- Modify: `apps/api/src/main.ts`
- Modify: `apps/worker/src/cli.ts`
- Modify: `apps/worker/src/real-worker.ts`
- Create: `apps/api/tests/stack-skill-startup.test.ts`
- Create: `apps/worker/tests/stack-skill-startup.test.ts`
- Modify: `packages/skills/tests/registry.test.ts`

- [ ] Write failing startup tests using an injected loader: API composition and fake/real worker startup must validate all built-ins before opening database pools/listeners or starting loops; malformed fixtures must terminate with a bounded file/schema error and no secret/guide echo.
- [ ] Run `pnpm vitest run packages/skills/tests/registry.test.ts apps/api/tests/stack-skill-startup.test.ts apps/worker/tests/stack-skill-startup.test.ts`; expect failure.
- [ ] Extract minimal startup/composition functions where needed so validation is directly testable without importing side-effectful listeners, then call `loadBuiltInStackSkills()` before API setup and before the worker fake/real branch.
- [ ] Ensure fake mode validates too, so CI/demo launch cannot bypass a broken built-in; missing deployment template keys remain non-fatal because registry validation checks keys, not environment-specific ids.
- [ ] Run `pnpm vitest run packages/skills/tests/registry.test.ts apps/api/tests/stack-skill-startup.test.ts apps/worker/tests/stack-skill-startup.test.ts`; expect pass.
- [ ] Commit with `git commit -am "fix: validate built-in skills at startup"`.

## Task 9: Show accessible stack status on project and task pages

**Files:**

- Create: `apps/web/components/stack-skill-badge.tsx`
- Modify: `apps/web/app/projects/[projectId]/page.tsx`
- Modify: `apps/web/app/tasks/[taskId]/page.tsx`
- Modify: `apps/api/src/task-database.ts`
- Test: `apps/web/tests/project-stack-skill.test.tsx`
- Test: `apps/web/tests/task-stack-skill.test.tsx`
- Test: `apps/api/tests/task-service.test.ts`

- [ ] Write failing UI tests for `Stack: TypeScript / Node`, an accessible tooltip listing available commands and `repo`/`skill` sources, the exact generic fallback copy, and legacy reports whose optional fields are absent.
- [ ] Run `pnpm vitest run apps/web/tests/project-stack-skill.test.tsx apps/web/tests/task-stack-skill.test.tsx`; expect failure.
- [ ] Add a small shared badge component using existing UI primitives. Do not expose internal ids, unavailable commands, raw output, or inferred sources for legacy rows.
- [ ] Extend the task read query/type with the project report needed by the badge, scoped through the existing `(organization_id, project_id)` relationship; keep all new response fields optional for compatibility.
- [ ] Render the badge on project and task pages. Render exactly `No stack skill for this project. Dhara will work it out, which may be slower.` for generic/no-match reports.
- [ ] Run `pnpm vitest run apps/web/tests/project-stack-skill.test.tsx apps/web/tests/task-stack-skill.test.tsx apps/api/tests/task-service.test.ts apps/web/tests/task-pages-model-unconfigured.integration.test.ts`; expect pass.
- [ ] Commit with `git commit -am "feat: show stack skill status in the UI"`.

## Task 10: Cross-cutting regression review and repository validation

**Files:**

- Modify only files required by failures attributable to this PR.
- Review: all changes from `a7b9841db1b086f4ad8863b964ff20b7227875f5`.

- [ ] Run the focused aggregate without PostgreSQL: `pnpm vitest run packages/skills/tests apps/api/tests/repository-analysis.test.ts apps/api/tests/report-hardening.test.ts apps/api/tests/task-intake.test.ts apps/api/tests/task-intake-job-type.test.ts apps/api/tests/task-service.test.ts apps/api/tests/task-plan-source-pin.test.ts apps/worker/tests/product-execution-source.test.ts apps/worker/tests/execution-store.test.ts apps/worker/tests/product-execution-orchestrator.test.ts apps/worker/tests/product-coding-runner.test.ts apps/worker/tests/b2-verification.test.ts apps/worker/tests/b3-verified-files.test.ts apps/worker/tests/b4-verification-order.test.ts apps/worker/tests/verification-incomplete.test.ts apps/web/tests/project-stack-skill.test.tsx apps/web/tests/task-stack-skill.test.tsx`; expect pass.
- [ ] Run `pnpm lint`; expect pass.
- [ ] Run `pnpm typecheck`; expect pass.
- [ ] Run `pnpm test:parallel`; expect pass.
- [ ] Run `git diff --check a7b9841db1b086f4ad8863b964ff20b7227875f5`; expect no whitespace errors.
- [ ] Inspect `git diff --stat` and `git diff a7b9841db1b086f4ad8863b964ff20b7227875f5` for scope, old-report compatibility, prompt trust boundaries, tenant filters, profile pinning order, absence of lint verification, absence of template retry logic, secret leakage, and accidental migration edits.
- [ ] Re-run the five Review Focus tests explicitly if their assertions are not obvious in the aggregate output.
- [ ] Use `superpowers:requesting-code-review` for an independent review of the complete baseline diff. Resolve every confirmed P0/P1 and relevant low-risk P2 with TDD, then repeat lint, typecheck, and `pnpm test:parallel`.
- [ ] Use `superpowers:verification-before-completion` and record fresh command output before claiming the PR is ready.
- [ ] Commit only any review-driven fixes with a focused message; do not squash or merge.

## Task 11: Open PR 1 and stop

- [ ] Confirm `git status --short`, `git log --oneline a7b9841db1b086f4ad8863b964ff20b7227875f5..HEAD`, and the final diff contain only PR 1 scope.
- [ ] Push `feat/stack-skills-pr1` and open one PR against `main`; do not merge it.
- [ ] In the PR body record migration `0013`, planning and implementation prompt-growth bounds, exact validation commands/results, that PostgreSQL integration tests were not run locally, and that no paid model/E2B/template build was performed.
- [ ] Confirm the PR diff includes the optional commented `E2B_TEMPLATE_TYPESCRIPT_NODE` example, the demo migration/fallback runbook note, and the only-`E2B_TEMPLATE_ID` launcher-preflight regression test.
- [ ] Include the owner-only future template build command as documentation, clearly marked **not run**, without credentials or an environment-specific template id.
- [ ] Attach the PR to this task, report the URL and validation evidence, then stop. Do not start PR 2 until the user reviews and merges PR 1.


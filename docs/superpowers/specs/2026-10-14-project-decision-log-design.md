# Per-project decision log design

## Purpose

Dhara should reuse verified knowledge from earlier work on the same project without treating that history as trusted instructions. The decision log records bounded facts Dhara already observes, supplies the newest relevant facts to clarification, planning, and implementation, and gives organization owners a readable way to remove knowledge that is wrong.

## Safety and precedence

- Repository evidence always wins over project history; project history wins over stack-skill defaults.
- History is serialized inside a labeled `<PROJECT_HISTORY>` block in user content. It is never placed in a system message.
- Dhara never stores raw ticket text or model-authored arbitrary memory. Every stored summary is deterministic and passes through the existing `maskPersonalData` function before insertion.
- Reads return at most 15 current entries and the prompt formatter caps the block at 800 tokens (3,200 characters).
- Superseded rows are immutable history and excluded from normal reads. Organization owners may mark an entry wrong by setting `superseded_by` to the row's own id; there is no hard-delete API.

## Data model

Migration `0014_project_decisions.sql` creates `project_decisions` with `id`, `organization_id`, `project_id`, nullable `task_id`, constrained `kind`, `summary` (1–300 characters), JSON `detail`, constrained `source`, `created_at`, and nullable `superseded_by`. Project, task, and self references use composite organization-scoped foreign keys. Forced RLS uses the existing tenant setting. `coding_agent_app` receives select/insert/update but not delete; API and worker continue entering the role through `withTenant()`.

Kinds are `command_worked`, `command_failed`, `convention`, `reviewer_accepted`, `reviewer_rejected`, and `rep_preference`. Sources are deterministic producer names: `verification`, `publication`, `zip_promotion`, and `plan_review`.

## Shared decision utilities

`packages/db/src/project-decisions.ts` owns the public row type, validation and normalization, deterministic masking/bounding helpers, and prompt formatting. Database adapters stay in their runtime packages so the shared package does not depend on the API or worker.

The formatter sorts newest first, excludes superseded rows defensively, emits only kind/date/summary, and truncates at entry and character caps without splitting the closing tag. It returns an empty string when no history exists.

## Read path

The API decision repository loads the newest 15 current entries for a tenant-scoped project. Task creation, clarification retry, and plan generation request the same project history and pass it to prompt builders. The clarification and planning user messages append the untrusted history block after repository context.

The worker source provider loads the same bounded history in the transaction that loads the approved task and adds it to `PreparedExecutionSource`. The coding task places the untrusted history after trusted stack guidance and command hints, before the approved task content. It explicitly states that repository evidence takes precedence.

## Write path

Only deterministic application code writes entries:

- Verification records what the command does on the unchanged baseline: `command_worked` when it passes there, `command_failed` when it does not. A failure that only the patch introduced is about that fix, not the command, and never marks the command as failed. When a command changes outcome, the previous current entry for the same command is superseded atomically.
- Successful GitHub publication writes `reviewer_accepted` describing the created pull request. ZIP promotion writes `reviewer_accepted` describing the promoted version. Retries remain idempotent.
- Rejecting a ready plan requires the requesting representative to provide a reason. Dhara masks it, records `reviewer_rejected`, updates the task to `rejected`, and audits the transition in one tenant transaction.

Dhara does not claim to observe GitHub merge or close events because no webhook/status-sync path exists today. Those outcomes are not fabricated; a future observer can call the same deterministic repository interface.

## API and UI

`GET /api/projects/:projectId/decisions` returns current entries plus the caller role. `POST /projects/:projectId/decisions/:decisionId/supersede` is owner-only, tenant-scoped, idempotent, and redirects back to the project page. `POST /tasks/:taskId/reject` records a masked reason and redirects back to the task.

The project page shows “What Dhara has learned about this project” with plain-language kind labels, date, summary, and a task link when present. Owners see “Mark as wrong”; other roles have read-only access. The empty state explains that Dhara learns only from completed checks and review outcomes.

## Validation

- Migration contract and PostgreSQL integration tests cover forced RLS, composite foreign keys, grants, tenant isolation, and superseding.
- Unit tests cover ordering, 15-entry/800-token caps, masking, prompt placement, and repository-evidence instructions.
- API and worker tests cover verification, publication, ZIP promotion, rejection authorization, and idempotency using fakes where external systems would otherwise be contacted.
- Web tests cover readable rendering and owner-only management controls.
- No paid model call, live E2B run, template build, or demo PostgreSQL test is part of this PR.

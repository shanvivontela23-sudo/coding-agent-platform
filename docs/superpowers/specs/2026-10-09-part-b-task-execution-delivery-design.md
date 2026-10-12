# Part B — Task Execution and Delivery Design

## Purpose

Part B turns an approved Dhara task into a verified implementation result and then delivers that result through the project's source channel. Execution must preserve the Phase 0 cost/security boundaries while adding durable product state, user controls, verification evidence, and developer handoff.

## Product boundary

Implementation is a separate paid attempt after planning approval. Dhara executes only the source identity pinned when the approved plan became ready. The execution result is never merged automatically. GitHub publication and ZIP result promotion happen only after implementation/verification and remain explicit developer/owner actions.

## Core execution flow

1. A permitted user starts one execution attempt for an approved task.
2. The API snapshots budget, timeout, approved source identity, and queues the attempt in PostgreSQL.
3. A restricted worker claims the attempt with a lease.
4. The worker prepares exactly the approved source, then runs the coding harness through the execution-scoped model gateway and sandbox boundary.
5. The patch is exported and checked for safety before it can become a product artifact.
6. Dhara independently verifies the exported patch in fresh model-free sandboxes.
7. Verification evidence, patch metadata, cost, and a sanitized change document are persisted.
8. A developer reviews the result. GitHub publication or ZIP result promotion is a separate post-execution action.

## Execution invariants

- One active execution per task. Repeated Start while active is idempotent.
- Every paid coding attempt is a separate durable execution. No automatic paid rerun occurs after a worker interruption or failed attempt.
- Durable progress records at least source prepared, coding started, coding finished, patch exported, and verified.
- A reclaimed lease may repeat only safe/model-free work. If `coding_started` exists without `coding_finished`, fail `WORKER_INTERRUPTED`; a user must start a new attempt.
- Worker terminal transitions are audited in the same transaction as status changes.
- Cancellation and wall-clock timeout can terminate work, and their state is visible to the worker.
- Execution history is append/update-only to the application role; result rows are not user-deletable.

## Source pinning

The task must pin the exact source the planner actually read, not merely an earlier project-report SHA/version. For GitHub, planner reads return the current default-branch commit and that exact commit is stored with the plan. For ZIP projects, the immutable project version read by planning is pinned.

Execution prepares exactly that pinned source. It does not silently move to a later default-branch head or ZIP version.

## Worker/security boundary

- PostgreSQL queue lease operations are exposed only to the dedicated `coding_agent_worker` role.
- `coding_agent_worker` is `NOSUPERUSER NOBYPASSRLS NOINHERIT` and has no direct tenant-table privileges.
- After a claim returns an organization id, the worker explicitly enters the application tenant role through `withTenant()` for that organization only.
- The API role cannot claim, heartbeat, or finish worker jobs.
- Sandbox dependency setup may use the configured dependency-network phase; coding follows the approved gateway/sandbox network phase; verification is offline/model-free.
- Publication credentials never enter a coding or verification sandbox.

## Coding runner

`CodingRunner` is the product orchestration boundary. The product implementation wraps the Phase 0 `SandboxProvider` and `HarnessRunner` contracts rather than inventing a second harness architecture.

A coding run receives only the approved requirement/plan and prepared source. It returns a patch, focused reproduction command when derivable, coding summary, and reconciled cost. The product runner persists cost even when the harness exits with a non-completed state such as limit-hit.

## Verification

Verification happens on clean copies of the approved source, not inside the model's coding sandbox.

### Baseline verification

Run the project report's dependency install command, then its test/build commands on the clean approved source before judging the patch. Pre-existing baseline failures do not automatically make the patch fail. A patched check is a new failure only when the clean baseline passed or when failing-test comparison proves a new failing test.

Verification must fail closed when Dhara cannot establish at least one passing baseline test or build. Missing commands, missing dependency setup for the recorded stack, failed dependency installation, or an all-failing/pre-existing baseline finish as `verification_incomplete`, never `succeeded`.

Project reports persist the dependency install command derived during repository analysis for the detected stack. Workers consume that persisted command rather than guessing from package-manager names. Legacy reports that do not contain the `installCommand` field are blocked before implementation spend and the task page says **Re-analyse this project before implementation**.

Dependency-install failure detail is treated as potentially secret-bearing. Before it can enter an execution failure message or change document, Dhara reuses the change-note sanitizer, redacts credential-bearing URLs, authorization headers and token patterns, and bounds the sanitized detail to the last 2,000 characters.

### Reproduce-first bug fixes

For a bug-fix task, the coding runner must add a regression test when it claims a proven fix. Dhara applies only the exported test hunk(s) to a clean approved source and runs the focused reproduction command. A proven fix requires a genuine assertion-style fail-before result and pass-after result on the fully patched clean copy. If that proof is absent, finish `fix_not_reproduced`; do not represent the result as proven.

### Clean patched verification

Create a second fresh sandbox, install dependencies from the project report, apply only the persisted exported patch, and run the configured checks. No model or gateway token is available in this sandbox.

## Patch safety

Before persisting a patch as usable output, enforce configured maximum file count and patch bytes, reject paths outside the repository root and symlink changes, reject CI/workflow configuration changes, scan patch text for secrets, and flag dependency/lockfile changes for developer review.

Unsafe patches do not become publishable/downloadable result artifacts.

## Change document

Every verified attempt stores a sanitized plain-language change document containing:

- what was asked;
- what changed and why;
- files touched;
- checks/results and verification completeness;
- reproduce-first proof when applicable;
- execution cost;
- developer review focus.

The document must not contain raw ticket text, PII, conversation transcripts, publication credentials, or secrets. The same stored document is the GitHub PR body and accompanies ZIP delivery.

## Source drift

### GitHub

Execution and publication remain anchored to the approved SHA. Movement of the default branch alone does not invalidate the result. At publication time Dhara compares the approved SHA with the current default-branch head and records how many commits the base moved.

Block with `source_changed` only when a file named in the approved plan or a file touched by the persisted patch changed between the approved SHA and current head. Otherwise branch from the approved SHA and allow the pull request even when the default branch advanced.

### ZIP

If the project's current ZIP version no longer matches the task's approved version, delivery blocks with `source_changed`. ZIP output itself is created as a new immutable version rather than mutating the approved input.

## Publication/delivery roles

The task-owning rep, developers, and owners may start/cancel implementation. Only developers and owners may publish a GitHub result or promote a ZIP result.

A `succeeded` GitHub execution may be published explicitly. A `fix_not_reproduced` execution may be published only when a developer or owner explicitly chooses the unproven publication path; the PR is visibly labelled unproven. `verification_failed` and `verification_incomplete` are never publishable.

## GitHub publication

GitHub publication runs only in the API/control plane after execution; the worker/sandbox never receives GitHub write credentials.

Before a paid GitHub implementation run is queued, Dhara checks the repository installation. The required GitHub App repository permission is **Contents: Read and write**. If the installation lacks Contents write, Start is blocked before an execution row/model spend and tells the owner exactly which permission to add.

Publication uses one deterministic branch per execution, created from the approved SHA. Retries and process restarts create-or-adopt that exact branch and open-or-adopt one pull request. Dhara never force-pushes and never merges.

The PR body is the already stored sanitized change document. Publication errors are stored as retryable publication failures and can be retried without a new paid execution. Publication never substitutes raw ticket text, transcripts, or model conversation into the PR.

## Part split

### B1 — Execution foundation

Add migration `0006`, API start/get/cancel, PostgreSQL queue lease contract, restricted roles/permissions foundation, worker loop with a fake runner in CI, task-page controls, and durable execution records. Stop before real sandbox/model orchestration.

### B2 — Orchestration, verification, safety, evidence

Add migration `0007` for the dedicated worker role, durable milestones, terminal audit behavior, append/update-only execution history, and B1 review corrections. Wire the real sandbox/gateway/harness contracts behind `CodingRunner` while faking them in CI. Add baseline checks, clean-copy verification, reproduce-first proof, patch limits, CI-path refusal, dependency/lockfile flags, secret scan, change document, ZIP diff view, execution cost display, the runnable worker command, and the 60-second waiting-for-worker state. Add an owner-run live smoke script behind explicit environment flags; do not run it automatically.

### B3 — GitHub publication

Add pre-spend Contents-write and legacy-report readiness checks, migration `0009` publication state, deterministic approved-SHA branches, idempotent PR creation/adoption after restart, publication-only retry, commit-distance recording, approved-plan/patch-file drift blocking, and control-plane publication UX. GitHub CI uses fakes only; no live publication write is required to review B3.

### B4 — ZIP delivery

Create the execution result as a new immutable ZIP project version, expose download, and allow only a developer or owner to promote that result to current.

## Security invariants

- Applied migrations `0001`–`0008` are immutable. B3 adds `0009` and only its checksum.
- Tenant-owned relationships keep composite `(organization_id, id)` foreign-key boundaries.
- `audit_events` remains append-only for the application role.
- `coding_agent_api` cannot claim/heartbeat/finish worker jobs after `0007`.
- `coding_agent_worker` has no direct tenant-table privileges and enters tenant data only through `withTenant()` after claiming an organization through the narrow queue functions.
- No runtime API or worker process connects as postgres/superuser.
- CI never makes paid model calls, live E2B calls, or live product GitHub publication writes.
- No automatic merge, no force-push, no automatic paid rerun, and no publication secret enters a coding sandbox.

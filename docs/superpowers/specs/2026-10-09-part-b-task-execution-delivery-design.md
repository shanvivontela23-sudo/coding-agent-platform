# Part B — Task Execution and Delivery

## Goal

Turn an approved Dhara task into a controlled implementation attempt that runs against the exact approved source, verifies the resulting patch independently, and hands a developer a reviewable result without ever merging automatically.

## Product flow

A support rep creates and clarifies a task, reviews Dhara's plain-language plan, and approves it. When the plan becomes `plan_ready`, Dhara pins the source used to create that plan: a GitHub commit SHA or an immutable ZIP project-version id. After approval, the task-owning rep, a developer, or an owner can start implementation. Start is idempotent and there is at most one active execution per task.

Every implementation is a separate execution attempt with its own snapshotted budget and wall-clock timeout. Failed, cancelled, or timed-out attempts are never automatically rerun. A later user-initiated attempt is a new record. Publication is separate from execution so publication-only failures can be retried without paying to rerun coding.

## Execution architecture

Product execution reuses the Phase 0 sandbox, model-gateway, and harness contracts behind a product orchestrator rather than creating a second execution stack. `CodingRunner` is the product-facing adapter over `HarnessRunner`. Automated tests and CI use fakes only: no paid model calls and no live E2B calls.

The execution queue is PostgreSQL-backed. Workers claim eligible rows with a lease using `FOR UPDATE SKIP LOCKED`; expired leases can be reclaimed without creating another execution attempt. The API uses the existing restricted `coding_agent_api` login and tenant `withTenant()` boundary. Cross-tenant worker claiming is exposed only through narrowly scoped `SECURITY DEFINER` queue functions with fixed search paths, fully qualified relations, PUBLIC execute revoked, and execute granted only to `coding_agent_api`.

Execution cancellation is user-controlled from the task page. Queued work can be cancelled immediately; running work records a cancellation request and the worker stops at the next control check. The wall-clock timeout is snapshotted with the execution budget and enforced independently of model/provider timeouts.

## Source pinning and drift

Source is pinned when the plan becomes `plan_ready`, because the plan is meaningful only for the source Dhara inspected.

For ZIP projects the pin is the immutable project-version id. Before execution or delivery, if the project's current version differs from that approved version, the result is `source_changed`.

For GitHub projects the pin is the approved commit SHA. A moving default branch does not itself block execution: Dhara runs on the approved SHA and later creates the delivery branch from it. At publication time Dhara records how many commits the default branch moved. It blocks with `source_changed` only if a file named in the approved plan changed between the approved SHA and the current head.

## Sandbox and network trust boundary

Treat every coding sandbox as compromised. Do not place GitHub App private keys, installation tokens, Supabase secrets, LiteLLM administrator credentials, database credentials, customer secrets, or other server credentials in it. The sandbox receives only source material, the approved task context, an execution-scoped model route/token when needed, and non-secret execution metadata.

Reuse the Phase 0 one-way network phases. Model access is present only during the coding phase. Verification runs in a separate fresh sandbox with no model access.

## Baseline and clean-copy verification

Before judging a patch, Dhara runs the project's reported test and build commands on a clean copy of the approved source. Failures already present on that baseline are recorded as pre-existing and do not make the execution `verification_failed`.

The coding sandbox exports a patch; it is not the verification environment. Dhara creates a second fresh sandbox from the approved source, applies only the exported patch, and runs verification there. A check fails the execution only when it is a new failure relative to baseline.

## Reproduce-first proof for bug tasks

For a bug task, the coding runner must add a test that captures the reported bug. Dhara itself—not the coding agent—runs that test on clean approved source and on clean patched source. The first run must fail and the second must pass. Both results are stored as execution proof.

If no such failing test can be produced, the execution is explicitly marked **fix not reproduced**. The patch may still be shown for review, but Dhara must not present it as a proven fix.

## Patch boundary and safety

Before a patch is accepted, stored for download, or published, Dhara enforces snapshotted limits for maximum changed files and total patch bytes, rejects paths outside the repository root, rejects symlinks, and refuses changes to `.github/workflows` or other configured CI files. Lockfile and dependency-manifest changes are allowed only as flagged review items in the result. A secret scan runs over the patch before any publication or downloadable storage.

## Checks, artifacts, and cost

Execution attempts own structured check records and artifact metadata. Model calls can link to the execution that incurred them while planning calls remain task-level. B1 establishes these durable records; later slices fill them with real patch, verification, proof, and publication data.

## Change document

Every successful execution stores one sanitized plain-language change document containing: what was asked, what changed and why, files touched, checks and results, reproduce-first proof (or `fix not reproduced`), total execution cost, and what a developer should inspect. It must not include the raw ticket, PII, transcripts, credentials, or secrets.

The same change document is shown on the task page, becomes the GitHub PR body, and is included as a file in a ZIP result.

## Delivery

GitHub delivery is server-only. Dhara creates a deterministic branch from the approved SHA, opens an idempotent PR, and can adopt that existing branch/PR after restart. Dhara never merges. The required GitHub App write permission is added only in B3 after the exact permission is stated to the owner and reviewed before it is needed.

ZIP delivery creates a new immutable project version. It is downloadable and has an in-app diff because there is no GitHub PR. Only developers and owners can publish a GitHub PR or promote a ZIP result to the project's current version.

## Roles

The support rep who owns the task, developers, and owners may start or cancel an execution. Other reps may view tenant-visible status but cannot control it. Only developers and owners may publish a GitHub PR or promote a ZIP result.

## User-visible terminal and blocking states

- `cancelled`: implementation was cancelled; nothing was published.
- `timed_out`: the execution exceeded its snapshotted wall-clock limit; nothing was published.
- `failed`: the coding/execution layer failed; nothing is automatically rerun.
- `verification_failed`: one or more checks newly fail on the clean patched copy.
- `fix_not_reproduced`: Dhara could not prove the bug with a fail-before/pass-after test and labels the result accordingly.
- `source_changed`: delivery is blocked only under the ZIP/current-version rule or GitHub approved-plan-file drift rule above.
- publication failure: the execution result remains intact and publication alone can be retried.

## PR boundaries

### B1 — execution foundation

Pin source at `plan_ready`; add migration `0006` for task executions, checks, artifacts, execution/model-cost linkage and queue leases; add idempotent start, cancellation, timeout, fake-runner worker flow, task-page Start implementation control, and polled execution status.

### B2 — real orchestration and verification

Wire the real sandbox/gateway/harness contracts behind `CodingRunner` while faking them in CI. Add baseline checks, clean-copy verification, reproduce-first proof, patch limits, CI-path refusal, dependency/lockfile flags, secret scan, change document, ZIP diff view, and execution cost display. Add an owner-run live smoke script behind explicit environment flags; do not run it automatically.

### B3 — GitHub publication

Add pre-spend permission check, deterministic branch, idempotent PR creation/adoption after restart, publication-only retry, approved-SHA branching, commit-distance recording, and approved-plan-file drift blocking. State the exact GitHub App permission the owner must add and stop before it is needed.

### B4 — ZIP delivery

Create the execution result as a new immutable ZIP project version, expose download, and allow only a developer or owner to promote that result to current.

## Security invariants

- Applied migrations `0001`–`0005` are immutable; Part B starts with new migration `0006` and adds only its checksum.
- Tenant-owned relationships keep composite `(organization_id, id)` foreign-key boundaries.
- `audit_events` remains append-only for the application role.
- No runtime API or worker process connects as postgres/superuser.
- CI never makes paid model calls or live E2B calls.
- No automatic merge, no automatic paid rerun, and no publication secret enters a coding sandbox.

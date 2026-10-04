# P0-03 sandbox boundary

P0-03 introduces a provider-neutral sandbox contract and the first E2B adapter for the Phase 0 benchmark.

## Security boundary

The sandbox is assumed compromised. The control plane owns credentials, repository acquisition, network policy, lifecycle, and the artifact/diff boundary.

The E2B API key is used only by the control-plane SDK client. It is never placed in sandbox environment variables.

GitHub credentials are never placed in the sandbox.

## Repository materialization

The sandbox does **not** clone the source repository.

The trusted control plane must acquire a tar.gz archive for exactly the task's 40-character `pinnedCommit` and provide:

- the pinned commit;
- the archive bytes;
- the SHA-256 of those exact bytes.

The adapter verifies the digest before sandbox creation and again after upload.

Before extraction, the sandbox rejects archive entries that are absolute, contain `..`, or contain a source `.git` path. The archive is extracted into `/workspace/repo`.

After extraction, the adapter creates a **new synthetic Git repository with one baseline commit**. This gives coding harnesses normal Git diff/status behavior without exposing the source repository's history.

The sandbox therefore has:

- the file tree from the pinned commit;
- one synthetic local baseline commit;
- no source Git remote;
- no earlier or later source commits;
- no GitHub credential.

A later GitHub-materializer slice must preserve this contract: it must resolve the archive outside the sandbox by the exact pinned SHA and must never pass a clone or source `.git` directory into the sandbox.

## Network phases

Every phase is default-deny.

| Phase | Allowed outbound traffic |
| --- | --- |
| locked/bootstrap | none |
| dependency-setup | explicit package registries and Git artifact hosts only |
| coding | model gateway hostname only |
| testing | model gateway hostname only |

Additional dependency hosts must be exact DNS hostnames. Wildcards, URLs, CIDRs, ports, localhost, and all-traffic entries are rejected.

The sandbox is also created with public ingress disabled.

E2B's network-update API replaces the egress policy atomically. The adapter therefore sends a complete allow/deny egress policy on every phase change.

## Provider contract

`SandboxProvider.create()` returns a `SandboxSession` supporting:

- command execution;
- workspace-scoped control-plane file reads/writes;
- network phase transitions;
- binary-capable Git patch export;
- snapshots;
- idempotent destruction.

The provider interface is deliberately independent from E2B so another sandbox backend can be benchmarked later without changing the agent/evaluation code.

## Patch handoff

The sandbox never pushes to GitHub. At the end of a run the control plane asks the session for:

- `git diff --binary HEAD`;
- porcelain workspace status.

The control plane validates and stores that patch. GitHub branch/commit/PR creation remains outside the sandbox.

## Live-provider verification

CI unit tests do not call E2B or require an E2B API key. Before gate runs, the rig still needs a live E2B smoke test against the selected stack images to verify:

- sandbox creation/destruction;
- archive upload/extraction;
- network phase enforcement;
- command timeouts;
- patch export.

That smoke test is operational validation, not a reason to put provider credentials in this public repository.

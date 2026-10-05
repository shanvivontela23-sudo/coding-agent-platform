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

Immediately after bootstrap, the control plane runs `git rev-parse HEAD`, validates the returned full SHA, and stores that synthetic baseline SHA on the sandbox session. Patch export always diffs from that recorded baseline SHA rather than from `HEAD`, so a harness cannot hide its work by committing its changes.

The sandbox therefore has:

- the file tree from the pinned commit;
- one synthetic local baseline commit before the harness begins;
- no source Git remote;
- no earlier or later source commits;
- no GitHub credential.

A later GitHub-materializer slice must preserve this contract: it must resolve the archive outside the sandbox by the exact pinned SHA and must never pass a clone or source `.git` directory into the sandbox.

## Network phases

Every phase is default-deny, and transitions are one-way in this order:

`locked -> dependency-setup -> coding -> testing`

Skipping forward or moving backward is rejected. Re-applying the current phase is an idempotent no-op.

| Phase | Allowed outbound traffic |
| --- | --- |
| locked/bootstrap | none |
| dependency-setup | default package registries plus explicit per-repo dependency hosts |
| coding | model gateway hostname only |
| testing | model gateway hostname only |

GitHub hosts are **not** in the default dependency allowlist. If one repository genuinely needs a GitHub-hosted dependency artifact during setup, the exact hostname must be opted in for that repository through `extraDependencyHosts`. That opt-in disappears when the sandbox advances to coding.

Additional dependency hosts must be exact DNS hostnames. Wildcards, URLs, CIDRs, ports, localhost, and all-traffic entries are rejected.

The sandbox is also created with public ingress disabled.

E2B's network-update API replaces the egress policy atomically. The adapter therefore sends a complete allow/deny egress policy on every phase change.

## Provider contract

`SandboxProvider.create()` returns a `SandboxSession` supporting:

- command execution;
- workspace-scoped control-plane file reads/writes;
- the recorded baseline commit SHA;
- one-way network phase transitions;
- binary-capable Git patch export from the recorded baseline;
- snapshots;
- idempotent destruction.

Control-plane file paths are normalized before the workspace boundary is checked, so `..` segments cannot escape `/workspace/repo`.

The provider interface is deliberately independent from E2B so another sandbox backend can be benchmarked later without changing the agent/evaluation code.

## Patch handoff

The sandbox never pushes to GitHub. At the end of a run the control plane asks the session for:

- `git diff --binary <recorded-baseline-sha> --`;
- porcelain workspace status.

The control plane validates and stores that patch. GitHub branch/commit/PR creation remains outside the sandbox.

The later evaluation collector must **not** run hidden tests against the potentially stateful harness workspace. It must apply the exported patch to a clean copy of the exact pinned source tree and run hidden/reference and regression tests there. This makes the collected proof independent of untracked state, generated files, or commits left behind by the harness.

## Live-provider verification

CI unit tests do not call E2B or require an E2B API key. Before gate runs, the rig still needs a live E2B smoke test against the selected stack images to verify:

- sandbox creation/destruction;
- archive upload/extraction;
- baseline recording and patch export after harness commits;
- one-way network phase enforcement;
- command timeouts;
- patch export.

The network smoke test must also prove the negative cases, not just an allowed request. At minimum it must verify that these fail when they are not allowlisted:

- a normal non-allowlisted hostname;
- a raw IPv4 address;
- an outside DNS name;
- an IPv6 destination.

That smoke test is operational validation, not a reason to put provider credentials in this public repository.

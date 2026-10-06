# P0-03 sandbox boundary

P0-03 introduces a provider-neutral sandbox contract and the first E2B adapter for the Phase 0 benchmark. P0-05 keeps that boundary intact and adds a committed live network-smoke runner that verifies the coding-phase policy from a real E2B guest.

## Security boundary

The sandbox is assumed compromised. The control plane owns credentials, repository acquisition, network policy, lifecycle, and the artifact/diff boundary.

The E2B API key is used only by the trusted control-plane/smoke-runner SDK client. It is never placed in sandbox environment variables. GitHub credentials, provider keys, LiteLLM admin/master credentials, and the model-gateway signing secret are never placed in the sandbox.

During coding/testing the harness receives only the public HTTPS model-gateway hostname and its short-lived signed run credential.

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

Any later repository materializer must preserve this contract: resolve the archive outside the sandbox by exact pinned SHA and never pass a clone or source `.git` directory into the guest.

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

GitHub hosts are **not** in the default dependency allowlist. If a repository genuinely needs a GitHub-hosted dependency artifact during setup, the exact hostname must be opted in through `extraDependencyHosts`. That opt-in disappears when the sandbox advances to coding.

Additional dependency hosts must be exact DNS hostnames. Wildcards, URLs, CIDRs, ports, localhost, and all-traffic entries are rejected.

The sandbox is created with public ingress disabled. E2B network wiring combines the exact hostname allowlist with deny-all CIDRs for both IP families: `0.0.0.0/0` and `::/0`. The allowlist is therefore the exception to an explicit IPv4/IPv6 deny-all policy, not a best-effort DNS-only restriction.

E2B's network-update API replaces the egress policy atomically. The adapter sends a complete allow/deny policy on every phase change.

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

The evaluation collector must **not** run hidden tests against the potentially stateful harness workspace. It must apply the exported patch to a clean copy of the exact pinned source tree and run hidden/reference and regression tests there. This makes the collected proof independent of untracked state, generated files, or commits left behind by the harness.

## Live E2B network verification

Public CI does not call E2B and does not require an E2B API key. The credentialed runner is `evals/smoke/e2b-network-smoke.ts`; it is deliberately opt-in behind `LIVE_SMOKE=1` and is not invoked by `.github/workflows/ci.yml`.

The live runner starts a fresh E2B guest directly in the coding-phase policy and proves all of the following:

- the reviewed public HTTPS gateway hostname is reachable;
- a normal non-allowlisted hostname is blocked;
- a raw IPv4 destination is blocked;
- a separate outside DNS hostname is blocked;
- direct IPv6 egress is blocked.

The current probes include a non-allowlisted host, raw `1.1.1.1`, an outside DNS name, and an IPv6 literal. A reachable negative target fails the smoke run. Sanitized evidence is written under ignored `evals/results/smoke/`; E2B credentials and guest command contents containing secrets are not evidence fields.

This smoke is operational validation only. The repository does not provision the E2B account, host, provider accounts, DNS, or credentials, and the presence of the runner is not evidence that live validation has been executed.

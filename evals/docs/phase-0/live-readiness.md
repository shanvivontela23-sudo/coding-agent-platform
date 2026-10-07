# Phase 0 live readiness

This note records the execution choices that must be true before credentialed TypeScript/Node smoke runs. Public CI remains mock-only and performs no E2B, provider, harness, or paid execution.

## Pinned sandbox template

`evals/sandbox-templates/typescript-node/template.ts` defines the E2B image used by live TypeScript/Node harness runs. As checked on 2026-10-07, it installs the current stable releases exactly:

- Claude Code `2.1.292`;
- Codex `0.160.1`.

The base image is also digest-pinned as `node:22-bookworm@sha256:1caeacc40090c4607170d7508b4eb8d5575a681a1b3a02b9cd65e878fa2d4779` so rebuilding the E2B template cannot silently move the OS/Node image.

The built E2B template identifier is deployment state, not a source-code constant. Live orchestration requires `E2B_TEMPLATE_ID` and passes that value to `Sandbox.create()` through `SandboxCreateRequest.template`. A live run fails closed when the id is absent.

## Fixed instruction

Instruction version `phase0-bugfix-v1` is defined in `evals/src/orchestrator/instruction.ts`. The orchestrator prepends the same instruction to every support-style ticket before either harness sees it. Any future text change requires a new instruction version.

## Limits and lifetime

Claude Code receives its supported `--max-turns` setting and the sandbox command timeout.

Codex CLI `0.160.1` does **not** expose a supported `codex exec` hard max-turns argument. This was re-checked against the release-tagged `codex-rs/exec/src/cli.rs` for `rust-v0.160.1`; its exec CLI exposes the prompt/output/config/shared options but no hard turn-count option. Passing an invented flag would make the benchmark depend on unsupported behavior, while checking the number of turns only after exit would not enforce a limit. Therefore Codex qualification continues to use the sandbox command timeout as the enforced wall-clock hard stop and records `turn.completed` events as `turnsUsed`. The qualification item “honors a turn limit” remains open for Codex until a supported CLI limit or an externally interruptible streaming process controller is added.

A harness sandbox is created for `setup timeout + run timeout + five-minute margin`. Dependency installation uses the setup timeout; the harness command uses the run timeout. The margin exists so a run that reaches the harness wall-clock limit still has time to export its patch and cleanly tear down. A harness command timeout still records `status = limit-hit`, `limit = time` and exports partial work before destruction.

## Codex provider boundary

Codex is configured with a dedicated custom provider named `benchmark_gateway`, not the built-in OpenAI provider. The adapter sets the provider base URL to the run gateway, selects `wire_api = "responses"`, reads auth from the run-scoped `OPENAI_API_KEY` environment value, and sets `features.responses_websockets = false` so all model traffic stays on the approved P0-05 HTTP Responses route.

## Local Anthropic tunnel profile

The operator may run `evals/deploy/http-gateway/compose.local.yaml` on a Mac. It contains only gateway, LiteLLM and PostgreSQL; Caddy remains exclusive to the production-style Compose file. The gateway binds to host loopback `127.0.0.1:8080`, LiteLLM management binds to `127.0.0.1:4000`, and an operator-selected tunnel outside Compose supplies public HTTPS. `GATEWAY_HOSTNAME` is the tunnel hostname only, not a URL.

This profile is Anthropic-only: `ANTHROPIC_API_KEY` is required and `OPENAI_API_KEY` is intentionally the empty string. Its dedicated preflight first proves incremental Anthropic SSE delivery through `https://${GATEWAY_HOSTNAME}` before running the remaining Claude/gateway checks. It never executes Codex or an OpenAI model.

## Collector validity and diagnostics

The unpatched regression suite is part of task validity. A non-zero unpatched baseline produces an `error` result with `collector.taskValidity = "invalid"`; it is not scored as a patched regression failure.

Collector-generated error rows include a bounded diagnostic record with the failing step and at most the final 2,048 characters of stderr/error text. Successful/ordinary scored rows carry `taskValidity = "valid"` with no failure record. Hidden reference content, prompt bodies, credentials, and model output are never copied into this diagnostic field.

## Paid operator commands

The local tunnel preflight and the one-task Claude end-to-end runner require the explicit live-smoke acknowledgement and are never invoked by CI. Both print their conservative estimated model-spend ceiling before making a paid provider request and print authoritative reconciled model spend at the end.

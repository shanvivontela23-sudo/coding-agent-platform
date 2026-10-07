# Phase 0 live readiness

This note records the execution choices that must be true before credentialed TypeScript/Node smoke runs. Public CI remains mock-only and performs no E2B, provider, harness, or paid execution.

## Pinned sandbox template

`evals/sandbox-templates/typescript-node/template.ts` defines the E2B image used by live TypeScript/Node harness runs. It installs exactly:

- Claude Code `2.0.0`;
- Codex `0.90.0`.

The built E2B template identifier is deployment state, not a source-code constant. Live orchestration requires `E2B_TEMPLATE_ID` and passes that value to `Sandbox.create()` through `SandboxCreateRequest.template`. A live run fails closed when the id is absent.

## Fixed instruction

Instruction version `phase0-bugfix-v1` is defined in `evals/src/orchestrator/instruction.ts`. The orchestrator prepends the same instruction to every support-style ticket before either harness sees it. Any future text change requires a new instruction version.

The instruction requires the harness to read the ticket and find the cause, write a failing bug test before production changes, make the smallest repository-fitting fix, run format/lint/build-or-type-check/affected tests, and finish with a short plain-language summary.

## Limits

Claude Code receives its supported `--max-turns` setting and the sandbox command timeout.

Codex CLI `0.90.0` does **not** expose a supported `codex exec` hard turn-count option in this integration. Passing an invented flag would make the benchmark depend on unsupported behavior, while checking the number of turns only after exit would not enforce a limit. Therefore Codex live qualification uses the sandbox command timeout as its enforced hard stop and records `turn.completed` events as `turnsUsed` for evidence. The qualification checklist item “honors a turn limit” remains open for Codex until a supported CLI limit or an externally interruptible streaming process controller is added. This limitation must be visible beside any benchmark result that uses Codex.

When the sandbox command itself times out, the adapter still exports the workspace patch and records the harness outcome as `limit-hit` with limit `time`; partial work is therefore measured instead of discarded.

## Codex provider boundary

Codex is configured with a dedicated custom provider named `benchmark_gateway`, not the built-in OpenAI provider. The adapter sets the provider base URL to the run gateway, selects `wire_api = "responses"`, reads auth from the run-scoped `OPENAI_API_KEY` environment value, and sets `features.responses_websockets = false` so all model traffic stays on the approved P0-05 HTTP Responses route.

## Collector validity and diagnostics

The unpatched regression suite is part of task validity. A non-zero unpatched baseline produces an `error` result with `collector.taskValidity = "invalid"`; it is not scored as a patched regression failure.

Collector-generated error rows include a bounded diagnostic record with the failing step and at most the last 2,048 characters of stderr/error text. Successful/ordinary scored rows carry `taskValidity = "valid"` with no failure record. Hidden reference content, prompt bodies, credentials, and model output are never copied into this diagnostic field.

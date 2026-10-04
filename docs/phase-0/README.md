# Phase 0 benchmark

This directory contains implementation notes and versioned benchmark artifacts.

## Invariants

1. Phase 0 benchmark code is separate from commercial product code.
2. A configuration means harness + model + frozen settings.
3. The same task, sandbox constraints, instruction, and limits apply to compared configurations.
4. No provider or GitHub credential enters a benchmark sandbox.
5. Every paid model operation must eventually be idempotent before gate runs.
6. Gate-run inputs are frozen; tuning starts a new version.
7. Held-out tasks are sealed from people tuning instructions and skills.
8. Every result is written by the collector, not manually.
9. Secrets and private customer material never enter this public repository.

## Next slices

- P0-02 dataset manifest and task validator
- P0-03 sandbox provider interface + E2B adapter
- P0-04 benchmark gateway / metering
- P0-05 harness adapters
- P0-06 evaluation collector
- P0-07 adversarial runner
- P0-08 reporting and gate decision

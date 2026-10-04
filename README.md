# Coding Agent Platform

Commercial AI coding-agent platform. This repository currently contains the **Phase 0 evaluation rig** used to answer one question before product development: can an existing coding harness turn support-style bug tickets into developer-acceptable fixes at commercially viable cost?

## Phase 0

The benchmark compares harness + model configurations on the same tasks, sandbox constraints, instructions, and scoring.

Initial evaluation dimensions:
- reproduction success
- hidden reference and regression tests
- build / type-check / lint
- scope compliance
- blind developer grading
- wall-clock time
- model and sandbox cost
- adversarial / security behavior

Product code does not start until the Phase 0 gate is evaluated.

## Development

Requires Node.js 22+ and pnpm 10+.

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
```

## Security

This repository is public. Never commit API keys, provider credentials, customer code, private tickets, canary values, or `.env` files.

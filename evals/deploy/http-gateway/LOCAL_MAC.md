# Local Mac gateway + tunnel runbook

This profile is for an operator-owned Mac using Docker Desktop. It does **not** run Caddy. A tunnel process chosen and started by the operator provides the public HTTPS address that E2B/Claude Code can reach.

The production-style `compose.yaml` and `Caddyfile` are unchanged.

## 1. Prepare environment

From the repository root, create an uncommitted `.env.local-gateway` with at least:

```text
GATEWAY_HOSTNAME=your-tunnel-hostname.example
MODEL_GATEWAY_RUN_TOKEN_SECRET=<32+ random characters>
LITELLM_MASTER_KEY=<random LiteLLM master key>
POSTGRES_PASSWORD=<random local password>
ANTHROPIC_API_KEY=<provider key>
OPENAI_API_KEY=
HARNESS_MODEL_PRICES_JSON={"anthropic/your-model":{"inputUsdPerMillionTokens":0,"outputUsdPerMillionTokens":0,"defaultMaxOutputTokens":1024}}
SMOKE_ANTHROPIC_MODEL=anthropic/your-model
E2B_API_KEY=<E2B key>
E2B_TEMPLATE_ID=<built TypeScript/Node template id>
```

Replace the zero prices with the current Anthropic list prices before any paid call. `GATEWAY_HOSTNAME` is **only the hostname**. Do not include `https://`, a path, query string, or trailing slash. `OPENAI_API_KEY` is intentionally empty in this profile.

Create the host state directory used by both the local gateway container and the trusted host-side operator commands:

```bash
mkdir -p .local/gateway-state
```

## 2. Start gateway, LiteLLM and PostgreSQL

```bash
docker compose \
  --env-file .env.local-gateway \
  -f evals/deploy/http-gateway/compose.local.yaml \
  build
docker compose \
  --env-file .env.local-gateway \
  -f evals/deploy/http-gateway/compose.local.yaml \
  up -d
```

The Node gateway is available only at `127.0.0.1:8080`. LiteLLM management is available only at `127.0.0.1:4000`. PostgreSQL is not published to the host.

## 3. Start the tunnel outside Compose

Use the tunnel provider of your choice and point it at:

```text
http://localhost:8080
```

Configure that tunnel so its public HTTPS hostname exactly matches `GATEWAY_HOSTNAME`. The repository intentionally does not install, provision, authenticate, or select a tunnel provider.

## 4. Run the paid local preflight

Load the same operator environment into your shell, then explicitly acknowledge the paid smoke:

```bash
set -a
source .env.local-gateway
set +a
export LIVE_SMOKE=1
pnpm exec tsx evals/smoke/local-tunnel-preflight.ts
```

The command prints its conservative estimated model spend before the provider request. Its **first request through the public tunnel** is an Anthropic streaming request. The preflight fails unless at least two response chunks are observed at distinct read times before `message_stop`, proving the tunnel path is not buffering the stream. It then verifies that the single call was recorded as the configured Anthropic model and that LiteLLM spend reconciled. No Codex or OpenAI model is executed. The actual reconciled model spend is printed at the end.

## 5. Run one private TypeScript task end to end with Claude Code

Prepare an operator-local JSON file outside version control and point `SINGLE_TASK_SPEC_PATH` to it. Example shape:

```json
{
  "taskId": "private-task-id",
  "difficulty": "easy",
  "split": "development",
  "ticketText": "private support ticket text",
  "model": "anthropic/your-model",
  "modelVersion": "provider-model-version",
  "repository": {
    "pinnedCommit": "0000000000000000000000000000000000000000",
    "archivePath": "/absolute/path/to/pinned-source.tar.gz",
    "archiveSha256": "0000000000000000000000000000000000000000000000000000000000000000"
  },
  "referenceFiles": ["src/example.ts"],
  "referenceDiffLines": 10,
  "hiddenFiles": [
    { "path": ".benchmark-hidden/reference.test.ts", "sourcePath": "/absolute/private/reference.test.ts" }
  ],
  "commands": {
    "install": "pnpm install --frozen-lockfile",
    "reproduction": "pnpm vitest run .benchmark-hidden/reproduction.test.ts",
    "reference": "pnpm vitest run .benchmark-hidden/reference.test.ts",
    "regression": "pnpm test",
    "build": "pnpm typecheck",
    "lint": "pnpm lint"
  },
  "dependencySetupCommand": "pnpm install --frozen-lockfile",
  "runTimeoutMs": 1200000,
  "maxTurns": 12,
  "spendCapUsd": 2
}
```

Then run:

```bash
export SINGLE_TASK_SPEC_PATH=/absolute/private/task.json
export LIVE_SMOKE=1
pnpm exec tsx evals/src/operator/single-claude-task-cli.ts
```

This command prints the authorized model-spend ceiling before starting, creates the coding sandbox, runs the pinned Claude Code harness, exports the patch, creates a **second fresh evaluator sandbox**, installs dependencies while registries are allowed, switches the evaluator offline, injects hidden evaluation files there only, scores the patch, finishes/reconciles the run, and atomically writes the final result row. It prints authoritative reconciled model spend at the end.

Neither paid command is referenced by CI.

## Stop local services

```bash
docker compose \
  --env-file .env.local-gateway \
  -f evals/deploy/http-gateway/compose.local.yaml \
  down
```

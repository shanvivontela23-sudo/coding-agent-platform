# Phase 0 harness gateway deployment

This directory is a working **deployment target**, not an infrastructure provisioner. Nothing here creates a DigitalOcean resource, changes DNS, funds an account, or writes a secret.

## Target

For Phase 0 use one DigitalOcean Basic-class VM with **2 vCPU / 4 GB RAM** and a stable public IP. The host exposes public TCP/443 through Caddy. Do not publish the Node gateway or PostgreSQL container ports. LiteLLM management is bound only to host loopback for the trusted operator/smoke runner. Restrict SSH to the operator's known source addresses or equivalent administrative access controls.

The Compose topology is:

`internet -> Caddy :443 -> Node gateway :8080 -> LiteLLM :4000 -> provider APIs`

LiteLLM also uses PostgreSQL on the private Compose network.

## Operator prerequisites

Before any record-and-forward or live smoke command is run, the operator owns these actions outside the repository:

1. create the VM and HTTPS DNS name;
2. create/fund the OpenAI account with **$25 prepaid** and automatic reload off;
3. create/fund the Anthropic account with **$25 prepaid** and automatic reload off;
4. create the E2B account/key;
5. generate one random LiteLLM master credential, the run-token signing secret, and PostgreSQL password;
6. enter all secret values only in the host `.env` (mode `0600` recommended);
7. set `HARNESS_MODEL_PRICES_JSON` to the exact list prices and maximum output defaults for every paid model allowed in the smoke configuration.

The provider balances are an outer containment layer. The gateway's per-run budget remains the inner limit.

## Required environment

Copy `.env.example` to `.env` on the host and fill it there. Never commit the populated file. Important values include:

- `GATEWAY_HOSTNAME`
- `MODEL_GATEWAY_RUN_TOKEN_SECRET`
- `LITELLM_MASTER_KEY`
- `POSTGRES_PASSWORD`
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `E2B_API_KEY` (needed by the trusted smoke runner, never the sandbox guest)
- `HARNESS_MODEL_PRICES_JSON`

Compose passes the same `LITELLM_MASTER_KEY` to LiteLLM as its master credential and maps it into the Node process as `LITELLM_ADMIN_TOKEN`. No second LiteLLM management secret needs to be generated or stored.

A model-price object has this shape:

```json
{
  "provider-model-name": {
    "inputUsdPerMillionTokens": 0,
    "outputUsdPerMillionTokens": 0,
    "defaultMaxOutputTokens": 1
  }
}
```

Use real current list prices on the host. The repository intentionally does not freeze a price table that can go stale.

The pre-dispatch reservation treats each UTF-8 request byte as one uncached input token and adds the request's `max_output_tokens`/`max_tokens` (or the configured default) at list price. This is a conservative guard only; LiteLLM's persisted usage/spend is authoritative after dispatch.

## Host state directory

The gateway container runs as the non-root `node` user (UID/GID 1000). Create the bind-mounted state directory with matching ownership before starting Compose so the gateway can persist run/call records without making the container root:

```text
sudo install -d -m 0700 -o 1000 -g 1000 "${GATEWAY_STATE_DIR:-/var/lib/coding-agent-platform}"
```

## Build and start

From the repository root on the provisioned host:

```text
docker compose --env-file .env -f evals/deploy/http-gateway/compose.yaml build
docker compose --env-file .env -f evals/deploy/http-gateway/compose.yaml up -d
```

The LiteLLM image build performs the real hash-locked install from `evals/litellm/requirements.txt`. Public CI intentionally performs only the dry-run verification.

Caddy is intentionally simple. No response-body transformation is configured. The live smoke test, not static config inspection, is authoritative for incremental SSE delivery and client-disconnect propagation.

## Route/model policy

The Node gateway remains the policy boundary. LiteLLM's wildcard forwarding entry does **not** authorize arbitrary harness models: every paid request must match the persisted run's exact `allowedModels` set before it reaches LiteLLM.

`POST /v1/chat/completions` remains disabled in `evals/config/http-gateway.json`. Do not enable it unless a sanitized transcript produced by the exact pinned benchmark harness demonstrates that it is required, and the transcript SHA-256 is placed in the frozen route evidence field.

## What this does not do

This deployment does not create provider/E2B accounts, preload balances, create the VM, change DNS, or execute live smoke. Those remain deliberate operator actions after PR C is reviewed and merged.

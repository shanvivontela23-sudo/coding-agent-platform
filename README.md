# Coding Agent Platform

Commercial AI coding-agent platform. The repository contains the Phase 0 evaluation rig under `evals/` and the product monorepo under `apps/` and `packages/`.

Product development now proceeds in parallel with evaluation. The former 40-task gate no longer blocks product work; a 10-task TypeScript/Node smoke set remains a regression check for harness/model changes.

## Product layout

- `apps/web` — Next.js web app and login page.
- `apps/api` — Node API, Supabase Auth integration, tenant session issuance.
- `apps/worker` — asynchronous worker boundary.
- `packages/db` — PostgreSQL schema and tenant-isolation checks.
- `evals` — benchmark, gateway, sandbox, and regression infrastructure.

## Run the product locally

Prerequisites: Node.js 22+, pnpm 10.17.1+, Docker, `psql`, and a Supabase project with email/password enabled. GitHub can optionally be enabled as a Supabase Auth provider for developer sign-in.

From the repository root, run these exact commands:

```bash
pnpm install --frozen-lockfile

docker rm -f coding-agent-postgres 2>/dev/null || true
docker run --name coding-agent-postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=coding_agent \
  -p 127.0.0.1:5432:5432 \
  -d postgres:16

until pg_isready -h 127.0.0.1 -p 5432 -U postgres; do sleep 1; done
PGPASSWORD=postgres psql \
  postgresql://postgres@127.0.0.1:5432/coding_agent \
  -f packages/db/migrations/0001_tenant_core.sql
```

Create the local organization, user, and membership after the user exists in Supabase Auth. Replace the two UUID placeholders with a generated local user UUID and the Supabase Auth user UUID:

```bash
export LOCAL_USER_ID="11111111-1111-4111-8111-111111111111"
export SUPABASE_USER_ID="22222222-2222-4222-8222-222222222222"
export LOCAL_ORG_ID="33333333-3333-4333-8333-333333333333"

PGPASSWORD=postgres psql postgresql://postgres@127.0.0.1:5432/coding_agent <<SQL
INSERT INTO organizations (id, name) VALUES ('$LOCAL_ORG_ID', 'Local');
INSERT INTO users (id, supabase_user_id, email) VALUES ('$LOCAL_USER_ID', '$SUPABASE_USER_ID', 'rep@example.com');
INSERT INTO organization_memberships (organization_id, user_id, role) VALUES ('$LOCAL_ORG_ID', '$LOCAL_USER_ID', 'rep');
SQL
```

Start the API in terminal 1:

```bash
export DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5432/coding_agent"
export SUPABASE_URL="https://YOUR_PROJECT_REF.supabase.co"
export SUPABASE_ANON_KEY="YOUR_SUPABASE_PUBLISHABLE_OR_ANON_KEY"
export SUPABASE_FLOW_SECRET="replace-with-at-least-32-random-characters"
export SESSION_SIGNING_SECRET="replace-with-another-at-least-32-random-characters"
export WEB_ORIGIN="http://localhost:3000"
export API_ORIGIN="http://localhost:3001"
pnpm --filter @coding-agent/api dev
```

Start the web app in terminal 2:

```bash
export NEXT_PUBLIC_API_ORIGIN="http://localhost:3001"
pnpm --filter @coding-agent/web dev
```

Open `http://localhost:3000`. Reps use email/password through Supabase Auth. Developers may use **Continue with GitHub** when GitHub is enabled in the Supabase project.

## Development checks

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm --filter @coding-agent/web build
```

## Security

This repository is public. Never commit API keys, OAuth credentials, provider credentials, customer code, private tickets, canary values, or `.env` files. Organization-owned rows use PostgreSQL row-level security. Tenant relationships use composite `(organization_id, id)` foreign keys, and `audit_events` is append-only for the application role.

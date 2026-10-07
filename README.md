# Coding Agent Platform

Commercial AI coding-agent platform. The working product name is **Dhara**; repository, package, database, and environment-variable names remain unchanged. The repository contains the Phase 0 evaluation rig under `evals/` and the product monorepo under `apps/` and `packages/`.

Product development proceeds in parallel with evaluation. The former 40-task gate no longer blocks product work; a 10-task TypeScript/Node smoke set remains a regression check for harness/model changes.

## Product layout

- `apps/web` — Next.js web app, login, onboarding, and signed-in home.
- `apps/api` — Node API, Supabase Auth integration, tenant session issuance, and tenant-scoped database access.
- `apps/worker` — asynchronous worker boundary.
- `packages/db` — PostgreSQL schema, restricted roles, RLS, and tenant-isolation checks.
- `evals` — benchmark, gateway, sandbox, and regression infrastructure.

## Run the product locally

Prerequisites: Node.js 22+, pnpm 10.17.1+, Docker, `psql`, and a Supabase project with email/password enabled. GitHub can optionally be enabled as a Supabase Auth provider for developer sign-in.

The schema migration is an administrator action. The running API is **never** configured with the postgres account; it connects as the restricted `coding_agent_api` login created by the migration.

From the repository root, install dependencies and start disposable PostgreSQL:

```bash
pnpm install --frozen-lockfile

docker rm -f coding-agent-postgres 2>/dev/null || true
docker run --name coding-agent-postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=coding_agent \
  -p 127.0.0.1:5432:5432 \
  -d postgres:16

until PGPASSWORD=postgres pg_isready -h 127.0.0.1 -p 5432 -U postgres -d coding_agent; do sleep 1; done
```

Apply the schema as the local administrator, then assign a local password to the already-created restricted API login:

```bash
PGPASSWORD=postgres psql \
  postgresql://postgres@127.0.0.1:5432/coding_agent \
  -v ON_ERROR_STOP=1 \
  -f packages/db/migrations/0001_tenant_core.sql

PGPASSWORD=postgres psql \
  postgresql://postgres@127.0.0.1:5432/coding_agent \
  -v ON_ERROR_STOP=1 \
  -c "ALTER ROLE coding_agent_api PASSWORD 'coding-agent-local-api';"
```

Start the API in terminal 1 using **only** the restricted login role:

```bash
export DATABASE_URL="postgresql://coding_agent_api:coding-agent-local-api@127.0.0.1:5432/coding_agent"
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

Open `http://localhost:3000`. Reps sign in with a Supabase email/password. Developers may use **Continue with GitHub** when the GitHub provider is enabled in Supabase. On a user's first successful sign-in, Dhara sends them to **Create your organization**; the API calls the narrowly scoped database bootstrap function, creates a new organization plus owner membership atomically, then issues the signed tenant session. No manual organization or membership seed is required.

### Database trust boundary

`coding_agent_api` is a `NOSUPERUSER NOBYPASSRLS NOINHERIT` login and has no direct tenant-table access. Authenticated tenant routes start a transaction, `SET LOCAL ROLE coding_agent_app`, then set the verified tenant UUID with a bound `set_config('app.organization_id', ..., true)`. Login membership lookup and first-run organization creation are the only SECURITY DEFINER database entry points available to the API login.

## Development checks

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm --filter @coding-agent/web build
```

## Security

This repository is public. Never commit API keys, OAuth credentials, provider credentials, customer code, private tickets, canary values, or `.env` files. Organization-owned rows use PostgreSQL row-level security. Tenant relationships use composite `(organization_id, id)` foreign keys, `audit_events` is append-only for the application role, and the API process must use `coding_agent_api` rather than a database administrator account.

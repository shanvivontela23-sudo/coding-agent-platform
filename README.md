# Coding Agent Platform

Commercial AI coding-agent platform. The working product name is **Dhara**; repository, package, database, and environment-variable names remain unchanged. The repository contains the Phase 0 evaluation rig under `evals/` and the product monorepo under `apps/` and `packages/`.

Product development proceeds in parallel with evaluation. The former 40-task gate no longer blocks product work; a 10-task TypeScript/Node smoke set remains a regression check for harness/model changes.

## Product layout

- `apps/web` — Next.js web app, login, onboarding, signed-in projects, members, and project reports.
- `apps/api` — Node API, Supabase Auth integration, tenant session issuance, GitHub App integration, and tenant-scoped database access.
- `apps/worker` — asynchronous worker boundary.
- `packages/db` — PostgreSQL schema, restricted roles, RLS, and tenant-isolation checks.
- `evals` — benchmark, gateway, sandbox, and regression infrastructure.

## Run the product locally

Prerequisites: Node.js 22+, pnpm 10.17.1+, Docker, `psql`, and a Supabase project with email/password enabled. GitHub can optionally be enabled as a Supabase Auth provider for developer sign-in. Connecting source repositories uses the separate Dhara GitHub App described below.

The schema migrations are administrator actions. The running API is **never** configured with the postgres account; it connects as the restricted `coding_agent_api` login created by the first migration.

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

Apply every numbered migration in order as the local administrator, then assign a local password to the already-created restricted API login:

```bash
for migration in packages/db/migrations/[0-9][0-9][0-9][0-9]_*.sql; do
  PGPASSWORD=postgres psql \
    postgresql://postgres@127.0.0.1:5432/coding_agent \
    -v ON_ERROR_STOP=1 \
    -f "$migration"
done

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
export GITHUB_APP_ID="YOUR_APP_ID"
export GITHUB_APP_SLUG="YOUR_APP_SLUG"
export GITHUB_APP_CLIENT_ID="YOUR_APP_CLIENT_ID"
export GITHUB_APP_CLIENT_SECRET="YOUR_APP_CLIENT_SECRET"
export GITHUB_APP_PRIVATE_KEY='-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----'
pnpm --filter @coding-agent/api dev
```

Start the web app in terminal 2:

```bash
export NEXT_PUBLIC_API_ORIGIN="http://localhost:3001"
pnpm --filter @coding-agent/web dev
```

Open `http://localhost:3000`. Reps sign in with a Supabase email/password. Developers may use **Continue with GitHub** when the GitHub provider is enabled in Supabase. On a user's first successful sign-in, Dhara sends them to **Create your organization**; the API calls the narrowly scoped database bootstrap function, creates a new organization plus owner membership atomically, then issues the signed tenant session. No manual organization or membership seed is required.

### Dhara GitHub App registration

The organization owner registers the GitHub App in GitHub and keeps all credentials on the API server. Configure these settings exactly:

- **Homepage URL:** the Dhara web origin.
- **Callback URL:** `${API_ORIGIN}/auth/github/installation/callback`
- **Request user authorization (OAuth) during installation: On**
- **Setup URL:** unavailable/unused while OAuth during installation is on; GitHub redirects to the callback URL after authorization.
- **Webhook: Off** for this slice.
- **Repository permissions:**
  - **Contents: Read**
  - **Pull requests: Read & write**
  - **Metadata: Read**
- Choose whether the app is installable only on the owner account or on any account according to the deployment policy.

Put these values in the server `.env` (the committed `.env.example` contains empty placeholders only):

- `GITHUB_APP_ID`
- `GITHUB_APP_SLUG`
- `GITHUB_APP_CLIENT_ID`
- `GITHUB_APP_CLIENT_SECRET`
- `GITHUB_APP_PRIVATE_KEY`
- `API_ORIGIN` and `WEB_ORIGIN`

The private key may be provided with literal `\n` escapes; the API converts them to newlines only in memory. GitHub user-access tokens used to verify installation ownership and GitHub installation tokens used to read repositories are short-lived server-side credentials. Dhara does not persist them, expose them to the browser, or log them.

**Contents: Write** will be needed in the later pull-request slice when Dhara begins writing branches/files. Do not grant that permission for this read-only analysis slice.

### Database trust boundary

`coding_agent_api` is a `NOSUPERUSER NOBYPASSRLS NOINHERIT` login and has no direct tenant-table access. Authenticated tenant routes start a transaction, `SET LOCAL ROLE coding_agent_app`, then set the verified tenant UUID with a bound `set_config('app.organization_id', ..., true)`. Login membership lookup, first-run organization creation, and the two verified invitation operations are the only SECURITY DEFINER database entry points available to the API login. GitHub installation and project-report persistence stays behind normal tenant RLS.

## Development checks

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm --filter @coding-agent/web build
```

## Security

This repository is public. Never commit API keys, OAuth credentials, provider credentials, customer code, private tickets, canary values, or `.env` files. Organization-owned rows use PostgreSQL row-level security. Tenant relationships use composite `(organization_id, id)` foreign keys, `audit_events` is append-only for the application role, and the API process must use `coding_agent_api` rather than a database administrator account. Repository analysis treats source archives as hostile input: entries are stream-parsed in memory with byte/file caps, special-link/device entries and unsafe paths are ignored, repository content is never executed, and only the deterministic report is retained.

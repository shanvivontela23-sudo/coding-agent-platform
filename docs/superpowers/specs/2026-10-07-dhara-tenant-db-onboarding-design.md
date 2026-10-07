# Dhara Tenant DB Boundary and Onboarding Design

## Goal

Ship the next Dhara product slice with a real PostgreSQL trust boundary before tenant routes, first-run organization onboarding, a signed-in home screen, safer session UX, and accurate eval sandbox accounting. No paid provider or E2B calls run in CI or during this slice.

## Product naming

The working product name is **Dhara**. It is defined once in product config and consumed by login UI, page metadata/titles, and the signed-in home screen. Repository name, package names, database objects, and environment variables remain unchanged.

## Database trust boundary

The API connects using a dedicated `coding_agent_api` PostgreSQL LOGIN role. It is `NOSUPERUSER`, `NOBYPASSRLS`, and does not own tenant tables. The existing `coding_agent_app` role stays `NOLOGIN` and is the restricted execution role for tenant queries.

Every authenticated tenant route uses `withTenant(pool, session, callback)`. The wrapper validates `session.organizationId` as a UUID, starts a transaction, executes `SET LOCAL ROLE coding_agent_app`, and sets the tenant with the bound query `SELECT set_config('app.organization_id', $1, true)` using the verified organization UUID. No organization id is interpolated into SQL. The wrapper commits on success and rolls back on failure, then releases the client. Tests prove a failed transaction leaves neither the role nor `app.organization_id` on the pooled connection.

## Login-time membership lookup

Login has exactly one privileged membership read: `lookup_memberships_for_supabase_user(uuid)`. It is `SECURITY DEFINER`, uses a fixed safe search path and fully qualified tables, returns only memberships belonging to the supplied Supabase user id, has PUBLIC execute revoked, and grants execute only to `coding_agent_api`.

Zero memberships enters onboarding. One membership issues the signed tenant session. Multiple memberships still fail closed until organization selection is implemented.

## First-run onboarding

Onboarding uses exactly one privileged creation function and adds no Supabase-user-id RLS policy:

`create_organization_with_owner(supabase_user_id uuid, email text, organization_name text)`

The function is `SECURITY DEFINER`, has a fixed safe search path, uses fully qualified tables, revokes PUBLIC execute, and grants execute only to `coding_agent_api`. It trims and validates organization names to 2–80 characters, refuses if the Supabase user already has any membership, generates both missing local ids itself, upserts only that caller's `users` row, creates a new organization, creates an owner membership, and returns the user and organization ids. It cannot accept or attach to an existing organization id because no organization id parameter exists. Tests prove an existing organization cannot be attached through this function.

The API stores a short-lived signed onboarding cookie containing verified Supabase identity data but no tenant organization. Posting the onboarding form calls the function, then replaces the onboarding cookie with the regular signed tenant session.

## Tenant home route and UI

`GET /api/home` verifies the signed tenant session, enters `withTenant`, and returns the organization name plus the tenant-visible project list. A real PostgreSQL integration test starts the actual API using the restricted login role, calls this route as tenant A, and proves tenant B projects do not appear.

The Next.js home screen shows Dhara, the organization name, a projects section with an empty state when no projects exist, and a sign-out form. The login page redirects first-time users to organization creation and renders sanitized form errors as readable copy rather than raw API JSON.

## Cookies and sign-out

Tenant, onboarding, and OAuth-flow cookies use `Secure` whenever the externally configured API origin is HTTPS. Sign-out expires the tenant session cookie and returns to login.

## Local development

Schema migration remains an administrator action. The README documents creating/configuring `coding_agent_api`, setting a local password, and starting the API with a `DATABASE_URL` for that restricted login role rather than postgres.

## Eval sandbox accounting

The one-task eval path records accumulated sandbox lifetime for coding and evaluator sandboxes. Result rows receive actual `sandboxSeconds` and `sandboxCostUsd`; cost is computed from an explicit configured USD-per-second value so accounting is deterministic and reviewable. Unit tests use a fake clock/provider and make no paid calls.

## Security invariants

- No tenant route directly uses `Pool.query` outside `withTenant`.
- No string-built tenant-setting SQL.
- No API runtime connection as postgres/superuser.
- No onboarding RLS policy keyed by Supabase user id.
- Privileged login/onboarding functions are narrowly scoped, SECURITY DEFINER, fixed-search-path, fully qualified, PUBLIC execute revoked, API role execute only.
- Failed tenant transactions restore pooled-connection role/tenant setting state.
- No paid calls in CI.

# Dhara GitHub Repository Connection and Deterministic Project Report Design

## Goal

Allow an authenticated Dhara organization owner or developer to install the Dhara GitHub App on selected repositories, prove that the returned installation really belongs to the GitHub user completing the flow, choose one repository, and create a Dhara project with a persisted deterministic project report. This slice makes no model or paid AI calls.

## Scope and success criteria

The slice is complete when:

- an owner or developer can start a GitHub App installation from the live `Connect a repository` action;
- installation callback state is signed, expiring, tenant/user-bound, single-use, and replay-safe;
- GitHub user authorization during installation is exchanged server-side and used to verify the installation before binding;
- a forged installation id, replayed state, or installation already bound to another Dhara organization is rejected;
- GitHub user and installation tokens are ephemeral server-only values and never persisted, sent to the browser, or logged;
- the user can list repositories visible to the bound installation and select one to create a project;
- the selected repository is analyzed without a model call, using deterministic repository metadata/tree/manifests/lockfiles;
- the project page shows repository name, default branch, last analyzed full commit SHA, and the deterministic report;
- README and `.env.example` fully document GitHub App setup;
- the four review follow-ups and signed-in web fixes in the request are implemented and covered by tests;
- one PR is left ready for review and is not merged.

## GitHub App installation flow

### Authorization to start

Only members with role `owner` or `developer` may start or complete the repository connection flow. A `rep` receives a safe authorization failure.

### State creation

Starting the installation flow creates a tenant-scoped database row containing:

- random state id;
- organization id;
- user id;
- expiry;
- consumed timestamp, initially null.

The API signs a compact state payload containing the state id, organization id, user id, expiry, and a fixed purpose. The signing key is `GITHUB_APP_STATE_SECRET`, separate from the tenant-session secret. The state expires after ten minutes.

The state row is consumed atomically during callback only when organization, user, id, expiry, and unconsumed status all match. A second attempt fails.

### Installation and OAuth callback verification

Dhara sends the browser to the GitHub App installation URL with the signed state. The GitHub App must have `Request user authorization (OAuth) during installation` enabled.

The callback must include a GitHub OAuth authorization code and the state. Dhara exchanges the code server-side using the app client id and client secret. The resulting GitHub user access token exists only in the callback call stack.

Dhara queries GitHub for installations accessible to that user. If the callback supplies an installation id, it is accepted only if it appears in that verified list. If no installation id is supplied, Dhara accepts only when exactly one accessible candidate is suitable for binding; zero or multiple candidates fail closed. This fallback handles the installation OAuth callback contract without guessing an installation id.

After verification, the user token is discarded. The verified installation id is bound to the current organization. A database unique constraint on installation id prevents a single GitHub installation from being bound to multiple Dhara organizations. Reconnecting the same organization to its already-bound installation is idempotent; binding another organization's installation is rejected.

## GitHub App server client

The API contains a focused GitHub App client that:

- creates RS256 app JWTs from `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`;
- exchanges OAuth codes using `GITHUB_APP_CLIENT_ID` and `GITHUB_APP_CLIENT_SECRET`;
- lists installations visible to a GitHub user token;
- mints installation tokens using the app JWT;
- lists repositories for an installation;
- reads repository metadata, branch HEAD/tree, and selected file contents.

Every outbound request uses the current GitHub REST API version header. Tokens are inserted only into outbound authorization headers, never into exceptions or logs.

No GitHub access token is stored in PostgreSQL. Only the installation id is durable.

## Repository selection and project creation

After installation binding, a server endpoint mints an installation token and lists repositories granted to that installation. The browser receives repository ids, full names, private/public indicator if useful to the UI, and default branches, but never the installation token.

Project creation accepts a repository id selected from that list. The API re-fetches the repository through the bound installation instead of trusting browser-supplied metadata. It resolves the current default branch full 40-character HEAD SHA and repository tree, reads only manifests/lockfiles required by the detector, computes the report, and writes project + repository metadata + report in one tenant transaction.

A repository already connected in the same organization is rejected with a typed conflict error rather than creating a duplicate project.

## Deterministic project analyzer

The analyzer lives under `packages/project-analysis` as dependency-free shared TypeScript so product code and eval code can use the same detector without product code importing benchmark internals.

### Inputs

A normalized repository snapshot contains:

- tree entries with path/type/optional size;
- a map of fetched UTF-8 manifest/lockfile contents.

### Output

`ProjectReport` contains:

- `languages`: recognized source languages with file counts and file-share fractions, sorted by descending file count then name;
- `frameworks`: deterministic deduplicated framework names sorted alphabetically;
- `packageManager`: detected package manager or null;
- `buildCommand`: deterministic command derived from manifest scripts/tooling or null;
- `testCommand`: deterministic command derived from manifest scripts/tooling or null;
- `stackSkill`: one of `typescript-node`, `python`, `java-spring`, `dotnet`, or `generic`.

### Detection rules

Languages are counted by recognized source-file extension, not bytes or GitHub Linguist output. Generated/vendor directories such as `node_modules`, `.git`, `dist`, `build`, `vendor`, and common cache directories are excluded. The denominator is recognized source files only.

Node projects detect pnpm/yarn/npm from lockfiles. Frameworks come from `package.json` dependencies/devDependencies using a fixed mapping for Next.js, React, Express, Fastify, and NestJS. Build/test commands are emitted only when the corresponding package script exists.

Python detects Django, Flask, FastAPI, and pytest from common manifest text; Java detects Spring and Maven/Gradle; .NET detects SDK-style projects and ASP.NET Web SDK. Commands are emitted only when file/manifest evidence supports them. No command is guessed merely from language.

Stack selection prefers explicit framework/build-system evidence. TypeScript/Node, Python, Spring, and .NET map to the existing eval stack vocabulary; everything else returns `generic`.

## Persistence

A new `0003` migration adds:

- `github_installations`: one row per organization, unique GitHub installation id, tenant RLS;
- `github_installation_states`: tenant/user-bound single-use state records, tenant RLS;
- repository metadata fields needed by the project page: GitHub full name, default branch, last analyzed commit SHA, deterministic report JSON.

Existing migrations `0001` and `0002` remain byte-for-byte unchanged.

## Migration immutability manifest

`packages/db/migrations/checksums.json` maps every `.sql` migration filename to a SHA-256 digest. The immutability test compares the exact sorted set of SQL files with the manifest keys and recomputes every digest. It fails if a listed migration changes or if a new SQL migration is not listed.

## Typed safe errors and logging

Known API failures use a typed `ApiError` carrying a short safe code and HTTP/redirect behavior. Logging emits only structured fields such as event, method, path, and safe code. It never serializes the raw error message, stack, request body, cookies, authorization headers, OAuth code, user token, app JWT, or installation token.

Unknown errors map to `internal_error` without exposing the raw exception.

## Review follow-ups

- Supabase `emailConfirmed` is true only when `email_confirmed_at` is a non-empty string; `confirmed_at` is ignored.
- `getMembers` returns pending invitations only to an owner; developer/rep responses contain an empty invitations list and do not need to query pending invites.
- All migrations are protected by the checksum manifest.
- All caught API failures log a safe typed error code.

## Web design

Signed-in primary navigation contains only `Projects` and `Members`. A client navigation component uses the current pathname: Projects is active for `/home`, `/connect/github`, and `/projects/*`; Members is active for `/members`. Active links use accent tint + accent text; inactive links use secondary text.

The home page primary `Connect a repository` action is live and starts the GitHub installation flow. No primary action is rendered disabled.

The repository-picker page shows repositories available to the verified installation and posts the selected repository id for project creation.

The project page shows repository full name, default branch, last analyzed commit, language shares, frameworks, package manager, build command, test command, and stack skill.

`How it works` card titles use `text-base font-medium`. Signed-in page titles remain `text-2xl`, section titles `text-lg`, and card titles `text-base`; no signed-in heading is larger than the page title.

## GitHub App registration documentation

README must specify:

- Contents: Read-only;
- Pull requests: Read & write;
- Metadata: Read-only;
- callback URL: `${API_ORIGIN}/github/callback` (local example `http://localhost:3001/github/callback`);
- Request user authorization (OAuth) during installation: On;
- webhook: Off for now;
- `.env`: `GITHUB_APP_SLUG`, `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_STATE_SECRET`;
- later pull-request-writing work will require Contents: Read & write.

## Testing strategy

Tests are written before implementation and cover:

- signed state expiry/mismatch and atomic replay rejection;
- forged installation id and ambiguous/no installation candidates;
- cross-organization unique installation binding;
- owner/developer authorization and rep denial;
- absence of tokens/raw error messages in responses/logs;
- deterministic analyzer fixtures for Node, Python, Spring, .NET, and generic fallback;
- repository selection re-verification and persisted report metadata;
- owner-only pending invites;
- email confirmation source;
- exact migration checksum manifest behavior;
- README/env contract and signed-in web source behavior.

Final verification is the repository CI gate: lint, typecheck, full tests including PostgreSQL integration, production Next.js build, and LiteLLM hash-lock verification.
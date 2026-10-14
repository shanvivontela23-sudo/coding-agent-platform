# Dhara Demo Runbook

This runbook prepares the owner-local Mac demo stack and then walks the two approved live demonstrations. The launcher and automated tests do **not** make model calls or create E2B sandboxes during setup/preflight. A real model/E2B charge begins only when an operator uses the product to run planning/implementation in the live demo.

## Prerequisites

Install:

- Node.js 22+
- pnpm 10.17.1+
- Docker Desktop
- PostgreSQL client tools (`psql`)
- ngrok CLI with an authenticated account

From the repository root:

```bash
pnpm install --frozen-lockfile
cp .env.example .env
```

`.env` is git-ignored. Never commit it, paste it into a ticket, or capture it in a screenshot.

## Configure `.env`

Fill the placeholders for:

- `DEMO_DATABASE_ADMIN_URL` — administrator URL used only to verify/apply a fresh local schema and read the demo organization's recorded GitHub installation.
- `DEMO_API_DATABASE_URL` — must authenticate as `coding_agent_api`.
- `DEMO_WORKER_DATABASE_URL` — must authenticate as `coding_agent_worker`.
- `DEMO_ORGANIZATION_ID` — optional; set it only when more than one connected GitHub installation exists in the demo database.
- Supabase: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_FLOW_SECRET`.
- Session/security: `SESSION_SIGNING_SECRET` and, optionally, `TASK_TICKET_ENCRYPTION_SECRET`.
- GitHub App: `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY`.
- E2B: `E2B_API_KEY` and `E2B_TEMPLATE_ID`. Build the template once with `pnpm exec tsx evals/sandbox-templates/typescript-node/build.ts` (E2B build time only, no model calls) and put the printed `E2B_TEMPLATE_ID` (a version-pinned `name:tag` reference) in `.env`. The plain E2B `base` template has no Codex CLI, so implementation fails without it.
- Model/gateway: `ANTHROPIC_API_KEY`, `LITELLM_MASTER_KEY`, `MODEL_GATEWAY_RUN_TOKEN_SECRET`, `TASK_MODEL_NAME`, `TASK_EXECUTION_MODEL`, `TASK_EXECUTION_CODEX_VERSION`, and `HARNESS_MODEL_PRICES_JSON`. The price map must contain entries for the exact planning and execution model names using the format documented in `.env.example`.
- ngrok: `NGROK_AUTHTOKEN`.
- Local LiteLLM Postgres: `POSTGRES_PASSWORD`.

The Dhara GitHub App used for implementation/publication must have exactly the write capability needed by B3:

**GitHub App → Repository permissions → Contents: Read and write**

Pull-request creation also requires the existing Pull requests read/write permission. Keep the GitHub App private key server-side.

The committed demo defaults are:

- planning cap: **$1.00 per planning run**
- implementation cap: **$2.00 per execution**
- API: `http://localhost:3101`
- web: `http://localhost:3000`

The UI shows the two caps before **Start implementation**. They are maximums, not estimates. Actual usage can be lower.

## Start the demo stack

Run one command from the repository root:

```bash
pnpm demo
```

The launcher performs these steps in order:

1. Validates every required variable by **name only**. Secret values are never printed.
2. Validates the numbered migration files against `packages/db/migrations/checksums.json`.
3. On a fresh local database, applies all numbered migrations in order. On an already-current database, it verifies the current schema/roles. An ambiguous partially migrated database is refused rather than guessed or re-applied.
4. Starts the checked-in local LiteLLM + HTTP gateway Compose stack.
5. Starts ngrok for local gateway port `8080` and discovers the HTTPS tunnel.
6. Runs all preflight checks.
7. Starts the API on `3101`, the web app on `3000`, and the **real** task worker.

`TASK_EXECUTION_FAKE_RUNNER` is deliberately unset in the demo worker. The launcher does not opt into fake execution.

### Expected preflight

All eleven checks should show ready:

```text
✓ API and web ports: ready
✓ database roles and migrations: ready
✓ Supabase: ready
✓ GitHub App Contents: Read and write: ready
✓ planning model price: ready
✓ execution model price: ready
✓ E2B authentication (list only): ready
✓ LiteLLM: ready
✓ ngrok gateway tunnel: ready
✓ gateway token minting: ready
✓ worker claim rollback dry-run: ready
```

Important safety properties:

- The API/web port check only binds locally long enough to prove the configured ports are free; it makes no external request.
- The GitHub permission check reads the installation recorded for the demo organization and verifies the permission that installation has actually accepted.
- E2B preflight **lists at most one sandbox record; it does not create a sandbox**.
- Worker claim preflight runs inside a transaction and rolls it back, so it cannot consume a queued execution.
- The gateway tunnel check reaches the HTTP gateway without sending a model request.
- GET/polling routes remain read-only.

If a check fails, fix that named dependency and rerun `pnpm demo`. Do not bypass a failed Contents-write, model-price, database-role, or gateway check for the live demo.

## Demo 1 — Public GitHub repository

Use a small public repository that is safe to demonstrate and contains no customer or secret material.

1. Open `http://localhost:3000` and sign in.
2. Connect/install the Dhara GitHub App for the demo repository.
3. Create the project and run repository analysis.
4. Create a support-style task with a small, reviewable change.
5. Answer any clarification questions and review the proposed plan.
6. Capture the task plan screen, including job-size/cost estimate and the **Demo spend caps** card.
7. Approve the plan.
8. Before clicking **Start implementation**, verify the UI still shows:
   - Planning cap · `$1.00` per planning run
   - Implementation cap · `$2.00` per execution
9. **Live paid step:** click **Start implementation**. This is the point where the real worker may create an E2B sandbox and make provider calls.
10. Watch queued/running/verification states. Do not refresh into a second attempt; execution start is idempotent and no automatic paid rerun is expected.
11. Review the resulting change note, diff, verification outcome, and actual execution cost.
12. As a developer/owner, click **Publish pull request** only after review.
13. Open the GitHub PR and verify:
    - deterministic Dhara branch
    - PR body equals the sanitized stored change note
    - no raw ticket/transcript/secrets
    - Dhara did **not** merge it automatically
14. Capture the result/diff/cost screen and the opened GitHub PR.

If the execution ends `fix_not_reproduced`, publication must be an explicit developer/owner choice and should be visibly marked unproven. Do not present it as a proven fix.

## Demo 2 — refund-service ZIP bug

Use the approved local `refund-service` demo ZIP fixture. Keep the fixture local/private if it contains anything that should not be committed to this public repository.

1. Create a ZIP-backed project and upload the approved source ZIP.
2. Run analysis and verify the project report is current.
3. Create the prepared refund bug ticket.
4. Answer clarification questions, review the proposed approach, and approve the plan.
5. Capture the plan and the Demo spend caps before Start.
6. **Live paid step:** click **Start implementation**.
7. Watch implementation and verification. For a reproduced bug, the expected path is fail-before/pass-after on the clean verification copy.
8. After a successful ZIP-backed execution, observe ZIP lifecycle states:
   - `Updated ZIP is waiting for a worker.`
   - `Building updated ZIP…`
   - ready artifact
9. Review the change note and result diff. Download both the approved source ZIP and updated ZIP if useful for the demo.
10. As a developer/owner, click **Promote to current version** only after review. Promotion must not overwrite the approved input automatically.
11. Capture the updated ZIP card and promoted version state.

If the worker crashes during ZIP construction, a pending build is recoverable by the next worker. A build left `building` for more than 10 minutes becomes `ZIP_RESULT_INTERRUPTED` and requires explicit developer/owner retry. Failed ZIP builds are never automatically retried.

If the bug cannot be reproduced, the updated ZIP is not created automatically. A developer/owner must explicitly choose **Accept unproven ZIP result**; keep the unproven status visible in the demo.

## Cost expectation

With the committed demo defaults, the **model budget ceiling for one task flow is up to $3.00** if it uses one planning run at the full `$1.00` cap and one implementation execution at the full `$2.00` cap. Actual provider usage may be less. E2B runtime charges during a real implementation are separate from that model-budget ceiling.

Avoid unnecessary reruns during a demo. Publication retry and ZIP-build retry reuse the existing execution and must not trigger another paid implementation attempt.

## Screens/checkpoints to capture

For a clean product walkthrough, capture:

- project/report screen after analysis
- task clarification/plan screen
- estimates plus **Demo spend caps** before Start
- queued/running status if useful
- final change note, diff, verification result, and actual execution cost
- GitHub PR for the repository flow, showing no auto-merge
- updated ZIP and promoted-version state for the ZIP flow

Do not capture `.env`, terminal output containing credentials, private tickets, customer code, or provider dashboards containing secrets.

## Shutdown

Press `Ctrl+C` in the `pnpm demo` terminal. The launcher stops API, web, worker, ngrok, and the checked-in local gateway Compose stack.

If the launcher was interrupted and cleanup did not finish, use:

```bash
docker compose --env-file .env \
  -f evals/deploy/http-gateway/compose.local.yaml down
```

Then verify no stale demo API/web/worker/ngrok process is still listening before the next run.

## Share the demo with someone on another computer

```bash
DEMO_SHARE=1 pnpm demo
```

This also starts a single-origin proxy on `127.0.0.1:3080` and a Cloudflare quick tunnel to it, and prints `Share link (works while this command runs): https://<random>.trycloudflare.com`. Web pages, form posts and API calls all go through that one address, because sessions are host-only cookies. The link changes every time the command restarts and stops working when it exits or the Mac sleeps. `cloudflared` must be installed.

Before sending the link:

1. **Sign-up email.** New people sign up at `/signup`. Supabase's built-in mailer only sends confirmation emails to members of your Supabase team, so for anyone else either turn off **Authentication → Providers → Email → Confirm email** in Supabase (sign-up then logs them straight in) or configure custom SMTP.
2. **Joining your organization.** Invite their email from **Members** first. After sign-up and sign-in they land on the invitation. Without an invite they create their own organization.
3. **Spend.** Anyone with the link can sign up and run tasks on your Anthropic and E2B credits. The caps are per run ($1 planning, $2 implementation), not totals; keep a spend limit on the Anthropic workspace.
4. **GitHub sign-in** needs the GitHub provider enabled in Supabase, plus `https://*.trycloudflare.com/**` in Supabase's redirect URLs. Email sign-up doesn't need either.

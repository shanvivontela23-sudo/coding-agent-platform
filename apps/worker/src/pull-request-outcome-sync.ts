import { setTimeout as delay } from "node:timers/promises";
import { type TenantPool, withTenant } from "../../api/src/database.js";
import { pullRequestStateFromGitHub, recordPullRequestOutcome, type PullRequestState } from "../../api/src/pull-request-outcome.js";
import { githubJwt } from "./product-execution-source.js";
import type { RestrictedQueryPool } from "./postgres-execution-queue.js";

export type PullRequestStateReader = {
  read(input: { readonly installationId: number; readonly repositoryFullName: string; readonly pullRequestNumber: number }): Promise<PullRequestState>;
};

// Reads one pull request with a short-lived installation token (read-only use).
export class GitHubPullRequestStateReader implements PullRequestStateReader {
  constructor(private readonly options: { readonly appId: string; readonly privateKey: string; readonly fetchImpl?: typeof fetch }) {}

  async read(input: { readonly installationId: number; readonly repositoryFullName: string; readonly pullRequestNumber: number }): Promise<PullRequestState> {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repositoryFullName) || input.repositoryFullName.split("/").some((part) => /^\.+$/.test(part))) throw new Error("GitHub repository full name is invalid");
    if (!Number.isSafeInteger(input.pullRequestNumber) || input.pullRequestNumber <= 0) throw new Error("pull request number is invalid");
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const headers = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
    const tokenResponse = await fetchImpl(`https://api.github.com/app/installations/${input.installationId}/access_tokens`, { method: "POST", headers: { ...headers, authorization: `Bearer ${githubJwt(this.options.appId, this.options.privateKey)}` } });
    if (!tokenResponse.ok) throw new Error(`GitHub installation token request failed with status ${tokenResponse.status}`);
    const token = (await tokenResponse.json() as { token?: unknown }).token;
    if (typeof token !== "string" || !token) throw new Error("GitHub installation token response did not contain a token");
    const [owner, repo] = input.repositoryFullName.split("/") as [string, string];
    const response = await fetchImpl(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${input.pullRequestNumber}`, { headers: { ...headers, authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`GitHub pull request lookup failed with status ${response.status}`);
    return pullRequestStateFromGitHub(await response.json() as Record<string, unknown>);
  }
}

type UnresolvedRow = { organization_id: string; publication_id: string; repository_full_name: string; pull_request_number: number; installation_id: string | number };

export async function syncPullRequestOutcomesOnce(options: {
  readonly pool: RestrictedQueryPool & Partial<TenantPool>;
  readonly reader: PullRequestStateReader;
  readonly limit?: number;
  readonly minAgeSeconds?: number;
  readonly log?: (event: Record<string, unknown>) => void;
}): Promise<{ readonly checked: number; readonly recorded: number; readonly failed: number }> {
  const listed = await options.pool.query<UnresolvedRow>("SELECT * FROM public.list_unresolved_pull_requests($1,$2)", [options.limit ?? 20, options.minAgeSeconds ?? 300]);
  let recorded = 0; let failed = 0;
  for (const row of listed.rows) {
    try {
      const state = await options.reader.read({ installationId: Number(row.installation_id), repositoryFullName: row.repository_full_name, pullRequestNumber: Number(row.pull_request_number) });
      const result = await withTenant(options.pool as unknown as TenantPool, { organizationId: row.organization_id }, async (database) => await recordPullRequestOutcome(database, row.organization_id, { publicationId: row.publication_id, state }));
      if (result === "recorded") { recorded += 1; options.log?.({ event: "pull_request_outcome_recorded", publicationId: row.publication_id, state }); }
    } catch (error) {
      // One unreachable repository must not stop the others; it is retried on the next pass.
      failed += 1;
      options.log?.({ event: "pull_request_outcome_check_failed", publicationId: row.publication_id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { checked: listed.rows.length, recorded, failed };
}

export async function runPullRequestOutcomeSync(options: {
  readonly pool: RestrictedQueryPool & Partial<TenantPool>;
  readonly reader: PullRequestStateReader;
  readonly signal: AbortSignal;
  readonly intervalMs?: number;
  readonly minAgeSeconds?: number;
  readonly log?: (event: Record<string, unknown>) => void;
}): Promise<void> {
  const intervalMs = options.intervalMs ?? 60_000;
  while (!options.signal.aborted) {
    try {
      await syncPullRequestOutcomesOnce({ pool: options.pool, reader: options.reader, ...(options.minAgeSeconds === undefined ? {} : { minAgeSeconds: options.minAgeSeconds }), ...(options.log ? { log: options.log } : {}) });
    } catch (error) {
      options.log?.({ event: "pull_request_outcome_sync_failed", error: error instanceof Error ? error.message : String(error) });
    }
    try { await delay(intervalMs, undefined, { signal: options.signal }); }
    catch (error) { if (!options.signal.aborted) throw error; }
  }
}

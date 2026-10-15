import { describe, expect, it } from "vitest";
import { GitHubPullRequestStateReader, runPullRequestOutcomeSync, syncPullRequestOutcomesOnce, type PullRequestStateReader } from "../src/pull-request-outcome-sync.js";
import type { PullRequestState } from "../../api/src/pull-request-outcome.js";
import { generateKeyPairSync } from "node:crypto";

const orgA = "00000000-0000-4000-8000-000000000941";
const orgB = "00000000-0000-4000-8000-000000000942";

function fakePool(rows: Array<{ organization_id: string; publication_id: string; repository_full_name: string; pull_request_number: number; installation_id: string }>) {
  const updates: Array<{ organizationId: unknown; publicationId: unknown; state: unknown }> = [];
  const tenants: unknown[] = [];
  const listCalls: unknown[][] = [];
  const query = async <Row>(text: string, values: readonly unknown[] = []): Promise<{ rows: Row[] }> => {
    if (text.includes("list_unresolved_pull_requests")) { listCalls.push([...values]); return { rows: rows as Row[] }; }
    if (text.includes("set_config('app.organization_id'")) tenants.push(values[0]);
    if (text.includes("SET pull_request_state='open'")) { updates.push({ organizationId: values[0], publicationId: values[1], state: "open" }); return { rows: [] }; }
    if (text.includes("UPDATE task_execution_publications AS p")) { updates.push({ organizationId: values[0], publicationId: values[1], state: values[2] }); return { rows: [{ execution_id: "50000000-0000-4000-8000-000000000941", task_id: "40000000-0000-4000-8000-000000000941", project_id: "20000000-0000-4000-8000-000000000941", pull_request_number: 1 }] as Row[] }; }
    if (text.includes("INSERT INTO project_decisions")) return { rows: [{ id: "d", organization_id: values[0], project_id: "p", task_id: "t", kind: values[3], summary: values[4], detail: {}, source: values[6], created_at: "2026-10-15T00:00:00.000Z", superseded_by: null }] as Row[] };
    return { rows: [] };
  };
  return { pool: { query, connect: async () => ({ query, release() {} }) }, updates, tenants, listCalls };
}

describe("pull request outcome sync", () => {
  it("checks each unresolved pull request in its own tenant and keeps going after one fails", async () => {
    const fake = fakePool([
      { organization_id: orgA, publication_id: "pub-a", repository_full_name: "acme/demo", pull_request_number: 2, installation_id: "11" },
      { organization_id: orgB, publication_id: "pub-b", repository_full_name: "other/gone", pull_request_number: 3, installation_id: "12" },
      { organization_id: orgB, publication_id: "pub-c", repository_full_name: "other/demo", pull_request_number: 4, installation_id: "12" },
    ]);
    const seen: unknown[] = [];
    const reader: PullRequestStateReader = { async read(input) { seen.push(input); if (input.repositoryFullName === "other/gone") throw new Error("not found"); return input.pullRequestNumber === 2 ? "merged" : "open"; } };
    const log: Array<Record<string, unknown>> = [];
    const result = await syncPullRequestOutcomesOnce({ pool: fake.pool, reader, limit: 5, minAgeSeconds: 30, log: (event) => log.push(event) });
    expect(result).toEqual({ checked: 3, recorded: 1, failed: 1 });
    expect(fake.listCalls).toEqual([[5, 30]]);
    expect(seen[0]).toEqual({ installationId: 11, repositoryFullName: "acme/demo", pullRequestNumber: 2 });
    expect(fake.tenants).toEqual([orgA, orgB]);
    expect(fake.updates).toEqual([{ organizationId: orgA, publicationId: "pub-a", state: "merged" }, { organizationId: orgB, publicationId: "pub-c", state: "open" }]);
    expect(log.map((event) => event.event)).toEqual(["pull_request_outcome_recorded", "pull_request_outcome_check_failed"]);
  });

  it("stops the periodic loop when aborted", async () => {
    const fake = fakePool([]);
    const controller = new AbortController();
    const reader: PullRequestStateReader = { async read(): Promise<PullRequestState> { return "open"; } };
    const running = runPullRequestOutcomeSync({ pool: fake.pool, reader, signal: controller.signal, intervalMs: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await expect(running).resolves.toBeUndefined();
    expect(fake.listCalls.length).toBe(1);
  });
});

describe("GitHub pull request reader", () => {
  it("uses an installation token and maps the pull request", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const requests: Array<{ url: string; method: string; authorization: string | null }> = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      requests.push({ url: String(url), method: init?.method ?? "GET", authorization: headers.get("authorization") });
      if (String(url).endsWith("/access_tokens")) return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
      return new Response(JSON.stringify({ number: 2, state: "closed", merged: true }), { status: 200 });
    }) as typeof fetch;
    const reader = new GitHubPullRequestStateReader({ appId: "123", privateKey: privateKey.export({ type: "pkcs1", format: "pem" }).toString(), fetchImpl });
    await expect(reader.read({ installationId: 11, repositoryFullName: "acme/demo", pullRequestNumber: 2 })).resolves.toBe("merged");
    expect(requests.map((request) => [request.method, request.url])).toEqual([
      ["POST", "https://api.github.com/app/installations/11/access_tokens"],
      ["GET", "https://api.github.com/repos/acme/demo/pulls/2"],
    ]);
    expect(requests[1]!.authorization).toBe("Bearer installation-token");
    await expect(reader.read({ installationId: 11, repositoryFullName: "../etc", pullRequestNumber: 2 })).rejects.toThrow(/invalid/);
  });
});

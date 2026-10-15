import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { attachGitHubWebhookRoutes, validGitHubSignature, type WebhookPool } from "../src/github-webhook.js";
import { pullRequestStateFromGitHub, recordPullRequestOutcome } from "../src/pull-request-outcome.js";

const org = "00000000-0000-4000-8000-000000000931";
const publicationId = "80000000-0000-4000-8000-000000000931";
const executionId = "50000000-0000-4000-8000-000000000931";
const secret = "webhook-test-secret";
const sign = (body: string, key = secret) => `sha256=${createHmac("sha256", key).update(body).digest("hex")}`;

type Call = { text: string; values: readonly unknown[] };
function fakePool(options: { readonly found: boolean; readonly state?: string | null }) {
  const calls: Call[] = [];
  const decisions: Array<{ kind: unknown; summary: unknown; detail: Record<string, unknown> }> = [];
  let state: string | null = options.state ?? null;
  const query = async <Row>(text: string, values: readonly unknown[] = []): Promise<{ rows: Row[] }> => {
    calls.push({ text, values });
    if (text.includes("find_publication_for_pull_request")) return { rows: (options.found ? [{ organization_id: org, publication_id: publicationId }] : []) as Row[] };
    if (text.includes("UPDATE task_execution_publications AS p")) {
      if (state === "merged" || state === "closed") return { rows: [] };
      state = String(values[2]);
      return { rows: [{ execution_id: executionId, task_id: "40000000-0000-4000-8000-000000000931", project_id: "20000000-0000-4000-8000-000000000931", pull_request_number: 7 }] as Row[] };
    }
    if (text.includes("FROM project_decisions") && text.includes("FOR UPDATE")) return { rows: [] };
    if (text.includes("INSERT INTO project_decisions")) {
      decisions.push({ kind: values[3], summary: values[4], detail: JSON.parse(String(values[5])) as Record<string, unknown> });
      return { rows: [{ id: "70000000-0000-4000-8000-000000000931", organization_id: org, project_id: "p", task_id: "t", kind: values[3], summary: values[4], detail: {}, source: values[6], created_at: "2026-10-15T00:00:00.000Z", superseded_by: null }] as Row[] };
    }
    return { rows: [] };
  };
  const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as WebhookPool;
  return { pool, calls, decisions, state: () => state };
}

let server: Server | null = null;
afterEach(async () => { await new Promise<void>((resolve) => { if (server) server.close(() => resolve()); else resolve(); }); server = null; });

async function start(pool: WebhookPool, webhookSecret: string | null = secret): Promise<string> {
  server = createServer((_request, response) => { response.statusCode = 299; response.end("product"); });
  attachGitHubWebhookRoutes(server, { apiOrigin: "http://127.0.0.1", secret: webhookSecret, pool });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function closedEvent(merged: boolean): string {
  return JSON.stringify({ action: "closed", installation: { id: 111 }, repository: { id: 222 }, pull_request: { number: 7, state: "closed", merged, merged_at: merged ? "2026-10-15T00:00:00Z" : null } });
}

describe("pull request state mapping", () => {
  it("maps GitHub's pull request fields to open, merged or closed", () => {
    expect(pullRequestStateFromGitHub({ state: "open", merged: false })).toBe("open");
    expect(pullRequestStateFromGitHub({ state: "closed", merged: true })).toBe("merged");
    expect(pullRequestStateFromGitHub({ state: "closed", merged_at: "2026-10-15T00:00:00Z" })).toBe("merged");
    expect(pullRequestStateFromGitHub({ state: "closed", merged: false, merged_at: null })).toBe("closed");
    expect(pullRequestStateFromGitHub({})).toBe("open");
  });

  it("writes the outcome to project memory under the publication's key, once", async () => {
    const fake = fakePool({ found: true });
    expect(await recordPullRequestOutcome(fake.pool, org, { publicationId, state: "merged" })).toBe("recorded");
    expect(await recordPullRequestOutcome(fake.pool, org, { publicationId, state: "merged" })).toBe("unchanged");
    expect(fake.decisions).toEqual([{ kind: "reviewer_accepted", summary: "Pull request #7 was merged.", detail: expect.objectContaining({ memoryKey: `publication:${executionId}`, outcome: "merged", pullRequestNumber: 7 }) }]);
  });

  it("records a closed pull request as rejected and an open one without memory", async () => {
    const fake = fakePool({ found: true });
    expect(await recordPullRequestOutcome(fake.pool, org, { publicationId, state: "open" })).toBe("unchanged");
    expect(fake.decisions).toEqual([]);
    expect(await recordPullRequestOutcome(fake.pool, org, { publicationId, state: "closed" })).toBe("recorded");
    expect(fake.decisions[0]).toMatchObject({ kind: "reviewer_rejected", summary: "Pull request #7 was closed without merging." });
  });
});

describe("GitHub webhook signature", () => {
  it("accepts only the exact HMAC of the raw body", () => {
    const body = Buffer.from("{\"a\":1}");
    expect(validGitHubSignature(secret, body, sign(body.toString()))).toBe(true);
    expect(validGitHubSignature(secret, body, sign(body.toString(), "other"))).toBe(false);
    expect(validGitHubSignature(secret, body, sign("{\"a\":2}"))).toBe(false);
    expect(validGitHubSignature(secret, body, undefined)).toBe(false);
    expect(validGitHubSignature(secret, body, "sha1=abc")).toBe(false);
    expect(validGitHubSignature(secret, body, "sha256=short")).toBe(false);
  });
});

describe("POST /github/webhook", () => {
  it("is off without a secret and leaves other routes to the product server", async () => {
    const fake = fakePool({ found: true });
    const origin = await start(fake.pool, null);
    expect((await fetch(`${origin}/github/webhook`, { method: "POST", body: closedEvent(true) })).status).toBe(404);
    expect((await fetch(`${origin}/api/anything`)).status).toBe(299);
    expect(fake.calls).toEqual([]);
  });

  it("rejects bad signatures before touching the database", async () => {
    const fake = fakePool({ found: true });
    const origin = await start(fake.pool);
    const body = closedEvent(true);
    const response = await fetch(`${origin}/github/webhook`, { method: "POST", body, headers: { "x-github-event": "pull_request", "x-hub-signature-256": sign(body, "wrong") } });
    expect(response.status).toBe(401);
    expect(fake.calls).toEqual([]);
  });

  it("answers ping, ignores other events and actions, and ignores pull requests Dhara did not open", async () => {
    const fake = fakePool({ found: false });
    const origin = await start(fake.pool);
    const post = async (event: string, body: string) => await fetch(`${origin}/github/webhook`, { method: "POST", body, headers: { "x-github-event": event, "x-hub-signature-256": sign(body) } });
    expect((await post("ping", "{}")).status).toBe(200);
    expect((await post("push", "{}")).status).toBe(202);
    expect((await post("pull_request", JSON.stringify({ action: "opened" }))).status).toBe(202);
    expect((await post("pull_request", "not json")).status).toBe(400);
    expect((await post("pull_request", JSON.stringify({ action: "closed", pull_request: { number: 7 } }))).status).toBe(400);
    const unknown = await post("pull_request", closedEvent(true));
    expect(unknown.status).toBe(202);
    expect(await unknown.json()).toEqual({ ignored: "not a Dhara pull request" });
    expect(fake.decisions).toEqual([]);
  });

  it("records a merged Dhara pull request in the tenant transaction", async () => {
    const fake = fakePool({ found: true });
    const origin = await start(fake.pool);
    const body = closedEvent(true);
    const response = await fetch(`${origin}/github/webhook`, { method: "POST", body, headers: { "x-github-event": "pull_request", "x-hub-signature-256": sign(body) } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: "recorded" });
    expect(fake.calls.find((call) => call.text.includes("find_publication_for_pull_request"))?.values).toEqual([111, 222, 7]);
    expect(fake.calls.some((call) => call.text === "SET LOCAL ROLE coding_agent_app")).toBe(true);
    expect(fake.state()).toBe("merged");
    expect(fake.decisions[0]).toMatchObject({ kind: "reviewer_accepted", summary: "Pull request #7 was merged." });
  });

  it("refuses payloads over 1 MB", async () => {
    const fake = fakePool({ found: true });
    const origin = await start(fake.pool);
    const body = "x".repeat(1_048_577);
    const response = await fetch(`${origin}/github/webhook`, { method: "POST", body, headers: { "x-github-event": "pull_request", "x-hub-signature-256": sign(body) } });
    expect(response.status).toBe(413);
  });
});

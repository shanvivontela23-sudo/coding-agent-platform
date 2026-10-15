import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { type TenantPool, withTenant } from "./database.js";
import { pullRequestStateFromGitHub, recordPullRequestOutcome } from "./pull-request-outcome.js";

const maxPayloadBytes = 1_048_576;

export type WebhookPool = TenantPool & { query<Row>(text: string, values?: readonly unknown[]): Promise<{ readonly rows: readonly Row[] }> };

function reply(response: ServerResponse, status: number, value: Record<string, unknown>): void {
  response.statusCode = status; response.setHeader("content-type", "application/json"); response.end(JSON.stringify(value));
}
async function rawBody(request: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > maxPayloadBytes) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

// GitHub signs the raw body with the webhook secret (X-Hub-Signature-256).
export function validGitHubSignature(secret: string, body: Buffer, header: string | undefined): boolean {
  if (!header || !header.startsWith("sha256=")) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
  const actual = Buffer.from(header);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// POST /github/webhook: records merged/closed outcomes for pull requests Dhara
// published. Off (404) unless GITHUB_WEBHOOK_SECRET is configured; the worker's
// periodic sync covers the same outcomes without a public webhook URL.
export async function handleGitHubWebhook(options: { readonly request: IncomingMessage; readonly response: ServerResponse; readonly secret: string | null; readonly pool: WebhookPool }): Promise<void> {
  const { request, response } = options;
  if (!options.secret) { reply(response, 404, { error: "not found" }); return; }
  const body = await rawBody(request);
  if (!body) { reply(response, 413, { error: "payload too large" }); return; }
  const signature = request.headers["x-hub-signature-256"];
  if (!validGitHubSignature(options.secret, body, Array.isArray(signature) ? signature[0] : signature)) { reply(response, 401, { error: "invalid signature" }); return; }
  const event = request.headers["x-github-event"];
  if (event === "ping") { reply(response, 200, { ok: true }); return; }
  if (event !== "pull_request") { reply(response, 202, { ignored: "event" }); return; }
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(body.toString("utf8")) as Record<string, unknown>; }
  catch { reply(response, 400, { error: "invalid JSON" }); return; }
  if (payload.action !== "closed") { reply(response, 202, { ignored: "action" }); return; }
  const pullRequest = payload.pull_request as Record<string, unknown> | undefined;
  const installationId = Number((payload.installation as { id?: unknown } | undefined)?.id);
  const repositoryId = Number((payload.repository as { id?: unknown } | undefined)?.id);
  const number = Number(pullRequest?.number);
  if (!pullRequest || ![installationId, repositoryId, number].every((value) => Number.isSafeInteger(value) && value > 0)) { reply(response, 400, { error: "missing pull request fields" }); return; }
  const found = await options.pool.query<{ organization_id: string; publication_id: string }>("SELECT * FROM public.find_publication_for_pull_request($1,$2,$3)", [installationId, repositoryId, number]);
  const match = found.rows[0];
  if (!match) { reply(response, 202, { ignored: "not a Dhara pull request" }); return; }
  const state = pullRequestStateFromGitHub(pullRequest);
  const result = await withTenant(options.pool, { organizationId: match.organization_id }, async (database) => await recordPullRequestOutcome(database, match.organization_id, { publicationId: match.publication_id, state }));
  reply(response, 200, { result });
}

export function attachGitHubWebhookRoutes(server: Server, options: { readonly apiOrigin: string; readonly secret: string | null; readonly pool: WebhookPool }): Server {
  const existing = server.listeners("request") as Array<(request: IncomingMessage, response: ServerResponse) => void | Promise<void>>;
  if (existing.length !== 1) throw new Error("product server must have exactly one request listener before GitHub webhook routes are attached");
  const productHandler = existing[0]!;
  server.removeAllListeners("request");
  server.on("request", (request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", options.apiOrigin);
      if (request.method === "POST" && url.pathname === "/github/webhook") { await handleGitHubWebhook({ request, response, secret: options.secret, pool: options.pool }); return; }
      await productHandler.call(server, request, response);
    })().catch(() => {
      if (!response.headersSent) response.statusCode = 500;
      if (!response.writableEnded) response.end("internal error");
    });
  });
  return server;
}

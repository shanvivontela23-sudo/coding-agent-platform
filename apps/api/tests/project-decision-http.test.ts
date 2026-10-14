import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionToken, type SessionIdentity } from "../src/auth.js";
import { attachProjectDecisionRoutes } from "../src/project-decision-http.js";
import type { ProjectDecisionService } from "../src/project-decision-service.js";

const sessionSecret = "project-decision-http-secret-at-least-32-characters";
const session: SessionIdentity = { organizationId: "00000000-0000-4000-8000-000000000611", userId: "10000000-0000-4000-8000-000000000611", expiresAtMs: Date.now() + 60_000 };
const projectId = "20000000-0000-4000-8000-000000000611";
const decisionId = "50000000-0000-4000-8000-000000000611";
const servers: ReturnType<typeof createServer>[] = [];

async function start(service: ProjectDecisionService): Promise<string> {
  const server = createServer((_request, response) => { response.statusCode = 404; response.end("fallback"); });
  servers.push(server);
  attachProjectDecisionRoutes(server, { apiOrigin: "http://127.0.0.1", webOrigin: "http://web.test", sessionSecret, service });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("missing address");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))); });

function service(): ProjectDecisionService {
  return {
    list: vi.fn(async () => ({ decisions: [], currentUserRole: "owner" as const })),
    supersede: vi.fn(async () => undefined),
  };
}

describe("project decision HTTP routes", () => {
  it("returns the tenant-scoped project history", async () => {
    const api = service(); const origin = await start(api);
    const response = await fetch(`${origin}/api/projects/${projectId}/decisions`, { headers: { cookie: `tenant_session=${encodeURIComponent(createSessionToken(session, sessionSecret))}` } });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ decisions: [], currentUserRole: "owner" });
    expect(api.list).toHaveBeenCalledWith(expect.objectContaining({ organizationId: session.organizationId }), projectId);
  });

  it("marks one decision wrong and redirects to the project", async () => {
    const api = service(); const origin = await start(api);
    const response = await fetch(`${origin}/projects/${projectId}/decisions/${decisionId}/supersede`, { method: "POST", redirect: "manual", headers: { cookie: `tenant_session=${encodeURIComponent(createSessionToken(session, sessionSecret))}` } });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`http://web.test/projects/${projectId}`);
    expect(api.supersede).toHaveBeenCalledWith(expect.objectContaining({ userId: session.userId }), projectId, decisionId);
  });

  it("leaves unrelated routes to the existing server", async () => {
    const origin = await start(service());
    const response = await fetch(`${origin}/health`);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("fallback");
  });
});

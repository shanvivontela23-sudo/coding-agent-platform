import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionToken, type SessionIdentity } from "../src/auth.js";
import { AppError } from "../src/errors.js";
import { attachOrganizationSkillRoutes } from "../src/organization-skill-http.js";
import type { OrganizationSkillService } from "../src/organization-skill-service.js";

const sessionSecret = "organization-skill-http-secret-at-least-32-characters";
const session: SessionIdentity = { organizationId: "00000000-0000-4000-8000-000000000711", userId: "10000000-0000-4000-8000-000000000711", expiresAtMs: Date.now() + 60_000 };
const ruleId = "80000000-0000-4000-8000-000000000711";
const cookie = () => ({ cookie: `tenant_session=${encodeURIComponent(createSessionToken(session, sessionSecret))}` });
const servers: ReturnType<typeof createServer>[] = [];

async function start(service: OrganizationSkillService): Promise<string> {
  const server = createServer((_request, response) => { response.statusCode = 404; response.end("fallback"); });
  servers.push(server);
  attachOrganizationSkillRoutes(server, { apiOrigin: "http://127.0.0.1", webOrigin: "http://web.test", sessionSecret, service });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("missing address");
  return `http://127.0.0.1:${address.port}`;
}
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))); });

function service(overrides: Partial<OrganizationSkillService> = {}): OrganizationSkillService {
  return {
    view: vi.fn(async () => ({ organization: { name: "Acme" }, currentUser: { email: null, role: "owner" as const }, rules: [], stacks: [], limits: { titleMaxChars: 100, bodyMaxChars: 2000, promptMaxChars: 4000, enabledChars: 0 } })),
    create: vi.fn(async () => undefined), update: vi.fn(async () => undefined), setEnabled: vi.fn(async () => undefined), remove: vi.fn(async () => undefined),
    ...overrides,
  };
}
const formHeaders = () => ({ ...cookie(), "content-type": "application/x-www-form-urlencoded" });

describe("organization rule HTTP routes", () => {
  it("returns the rules view for the signed-in organization", async () => {
    const api = service(); const origin = await start(api);
    const response = await fetch(`${origin}/api/organization/rules`, { headers: cookie() });
    expect(response.status).toBe(200);
    expect(api.view).toHaveBeenCalledWith(expect.objectContaining({ organizationId: session.organizationId }));
  });

  it("creates a rule from the form, with repeated stack checkboxes, and redirects with a notice", async () => {
    const api = service(); const origin = await start(api);
    const response = await fetch(`${origin}/organization/rules`, { method: "POST", redirect: "manual", headers: formHeaders(), body: "title=Changelog&body=Update+CHANGELOG.md&stacks=python&stacks=dotnet" });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("http://web.test/rules?notice=");
    expect(api.create).toHaveBeenCalledWith(expect.anything(), { title: "Changelog", body: "Update CHANGELOG.md", appliesToStacks: ["python", "dotnet"] });
  });

  it.each([["update", "update"], ["enable", "setEnabled"], ["disable", "setEnabled"], ["delete", "remove"]] as const)("routes %s", async (action, method) => {
    const api = service(); const origin = await start(api);
    const response = await fetch(`${origin}/organization/rules/${ruleId}/${action}`, { method: "POST", redirect: "manual", headers: formHeaders(), body: "title=T&body=B" });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://web.test/rules");
    expect(api[method]).toHaveBeenCalled();
  });

  it("shows a forbidden or invalid message on the rules page", async () => {
    const origin = await start(service({ create: vi.fn(async () => { throw new AppError("ORGANIZATION_RULE_FORBIDDEN", "Only an organization owner can change coding rules.", 403); }) }));
    const response = await fetch(`${origin}/organization/rules`, { method: "POST", redirect: "manual", headers: formHeaders(), body: "title=T&body=B" });
    expect(decodeURIComponent(response.headers.get("location") ?? "").replace(/\+/g, " ")).toContain("error=Only an organization owner can change coding rules.");
  });

  it("refuses oversized forms and requires sign-in", async () => {
    const origin = await start(service());
    const big = await fetch(`${origin}/organization/rules`, { method: "POST", redirect: "manual", headers: formHeaders(), body: `title=T&body=${"x".repeat(20_000)}` });
    expect(decodeURIComponent(big.headers.get("location") ?? "").replace(/\+/g, " ")).toContain("That rule is too long.");
    const anonymous = await fetch(`${origin}/api/organization/rules`);
    expect(anonymous.status).toBe(401);
  });

  it("leaves unrelated routes to the existing server", async () => {
    const response = await fetch(`${await start(service())}/health`);
    expect(await response.text()).toBe("fallback");
  });
});

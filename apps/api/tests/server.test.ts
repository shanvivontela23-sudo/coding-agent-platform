import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { createSessionToken } from "../src/auth.js";
import { createApiServer } from "../src/server.js";
import type { ProductDatabase } from "../src/database.js";

const sessionSecret = "test-session-secret-that-is-long-enough";
const userId = "10000000-0000-4000-8000-000000000001";
const organizationId = "00000000-0000-4000-8000-000000000001";
const supabaseUserId = "60000000-0000-4000-8000-000000000001";

function database(overrides: Partial<ProductDatabase> = {}): ProductDatabase {
  return {
    lookupMemberships: async () => [{ userId, organizationId, role: "rep" }],
    createOrganizationWithOwner: async () => ({ userId, organizationId }),
    getHome: async () => ({ organization: { id: organizationId, name: "Acme" }, user: { id: userId, email: "rep@example.com" }, projects: [] }),
    getMembers: async () => ({ organization: { id: organizationId, name: "Acme" }, currentUser: { id: userId, email: "rep@example.com", role: "rep" }, members: [], invitations: [] }),
    createInvitation: async (_session, email, role) => ({ id: "70000000-0000-4000-8000-000000000001", organizationId, organizationName: "Acme", email, role, expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    listVerifiedInvitations: async () => [],
    acceptVerifiedInvitation: async () => ({ userId, organizationId }),
    ...overrides,
  };
}

function auth() {
  return {
    signInWithPassword: async () => ({ supabaseUserId, email: "rep@example.com", provider: "email" as const }),
    startGitHubOAuth: () => ({ authorizationUrl: "https://project-ref.supabase.co/auth/v1/authorize?provider=github", flowId: "flow-1", flowCookie: "signed-flow-cookie" }),
    completeGitHubOAuth: async () => ({ supabaseUserId, email: "dev@example.com", provider: "github" as const }),
  };
}

async function withServer(
  run: (baseUrl: string) => Promise<void>,
  options: { readonly apiOrigin?: string; readonly database?: ProductDatabase; readonly auth?: ReturnType<typeof auth> } = {},
): Promise<void> {
  const server = createApiServer({
    webOrigin: "http://localhost:3000",
    apiOrigin: options.apiOrigin ?? "http://localhost:3001",
    sessionSecret,
    sessionDurationMs: 60_000,
    onboardingDurationMs: 10 * 60_000,
    auth: options.auth ?? auth(),
    database: options.database ?? database(),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind a TCP port");
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { server.close(); await once(server, "close"); }
}

function tenantCookie(): string {
  return `tenant_session=${encodeURIComponent(createSessionToken({ userId, organizationId, expiresAtMs: Date.now() + 60_000 }, sessionSecret))}`;
}

describe("product API server", () => {
  it("starts and serves health", async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/health`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true, service: "api" });
    });
  });

  it("signs an existing member in and redirects to home", async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/auth/email`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email: "rep@example.com", password: "password" }), redirect: "manual" });
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("http://localhost:3000/home");
      expect(response.headers.get("set-cookie")).toContain("tenant_session=");
      expect(response.headers.get("set-cookie")).not.toContain("onboarding_session=");
    });
  });

  it("sends a first-time user to organization onboarding", async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/auth/email`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email: "new@example.com", password: "password" }), redirect: "manual" });
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("http://localhost:3000/onboarding");
      expect(response.headers.get("set-cookie")).toContain("onboarding_session=");
    }, { database: database({ lookupMemberships: async () => [] }) });
  });

  it("creates an organization from the signed onboarding identity and issues the tenant session", async () => {
    let createdName = "";
    const db = database({
      lookupMemberships: async () => [],
      createOrganizationWithOwner: async (_identity, organizationName) => {
        createdName = organizationName;
        return { userId, organizationId };
      },
    });
    await withServer(async (baseUrl) => {
      const login = await fetch(`${baseUrl}/auth/email`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email: "new@example.com", password: "password" }), redirect: "manual" });
      const onboardingCookie = login.headers.get("set-cookie")?.split(";")[0];
      expect(onboardingCookie).toBeTruthy();
      const response = await fetch(`${baseUrl}/onboarding/organization`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie: onboardingCookie! }, body: new URLSearchParams({ organizationName: "  New Team  " }), redirect: "manual" });
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("http://localhost:3000/home");
      expect(response.headers.get("set-cookie")).toContain("tenant_session=");
      expect(response.headers.get("set-cookie")).toContain("onboarding_session=;");
      expect(createdName).toBe("New Team");
    }, { database: db });
  });

  it("sets Secure on auth cookies whenever the configured API origin is HTTPS", async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/auth/email`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email: "rep@example.com", password: "password" }), redirect: "manual" });
      expect(response.headers.get("set-cookie")).toContain("Secure");
    }, { apiOrigin: "https://api.example.test" });
  });

  it("redirects form failures to readable login-page copy instead of raw JSON", async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/auth/email`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email: "rep@example.com", password: "wrong" }), redirect: "manual" });
      expect(response.status).toBe(303);
      const location = new URL(response.headers.get("location")!);
      expect(location.origin).toBe("http://localhost:3000");
      expect(location.searchParams.get("error")).toBe("Sign-in failed. Check your email and password.");
    }, { auth: { ...auth(), signInWithPassword: async () => { throw new Error('{"error":"invalid_grant"}'); } } });
  });

  it("returns tenant home data only for a verified session", async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/home`, { headers: { cookie: tenantCookie() } });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ organization: { id: organizationId, name: "Acme" }, user: { id: userId, email: "rep@example.com" }, projects: [] });
    });
  });

  it("signs out by expiring the tenant cookie and returning to login", async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/auth/sign-out`, { method: "POST", headers: { cookie: tenantCookie() }, redirect: "manual" });
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("http://localhost:3000");
      expect(response.headers.get("set-cookie")).toContain("tenant_session=;");
      expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    });
  });
});

import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { createOnboardingToken, createSessionToken } from "../src/auth.js";
import { createApiServer } from "../src/server.js";
import type { ProductDatabase } from "../src/database.js";

const sessionSecret = "test-session-secret-that-is-long-enough";
const userId = "10000000-0000-4000-8000-000000000031";
const organizationId = "00000000-0000-4000-8000-000000000031";
const supabaseUserId = "60000000-0000-4000-8000-000000000031";
const inviteId = "70000000-0000-4000-8000-000000000031";

type Invite = {
  readonly id: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly email: string;
  readonly role: "developer" | "rep";
  readonly expiresAt: string;
};

type ExtraDatabase = {
  listVerifiedInvitations(identity: { readonly supabaseUserId: string; readonly email: string | null; readonly emailConfirmed?: boolean }): Promise<Invite[]>;
  acceptVerifiedInvitation(identity: { readonly supabaseUserId: string; readonly email: string | null; readonly emailConfirmed?: boolean }, invitationId: string): Promise<{ readonly userId: string; readonly organizationId: string }>;
  getMembers(session: { readonly userId: string; readonly organizationId: string }): Promise<unknown>;
  createInvitation(session: { readonly userId: string; readonly organizationId: string }, email: string, role: "developer" | "rep"): Promise<unknown>;
};

function baseDatabase(extra: Partial<ExtraDatabase> = {}): ProductDatabase {
  const invitation: Invite = {
    id: inviteId,
    organizationId,
    organizationName: "Acme",
    email: "invitee@example.com",
    role: "developer",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const value = {
    lookupMemberships: async () => [],
    createOrganizationWithOwner: async () => ({ userId, organizationId }),
    getHome: async () => ({ organization: { id: organizationId, name: "Acme" }, projects: [] }),
    listVerifiedInvitations: async () => [invitation],
    acceptVerifiedInvitation: async () => ({ userId, organizationId }),
    getMembers: async () => ({ organization: { id: organizationId, name: "Acme" }, currentUser: { id: userId, email: "owner@example.com", role: "owner" }, members: [], invitations: [] }),
    createInvitation: async () => invitation,
    ...extra,
  };
  return value as unknown as ProductDatabase;
}

function auth(emailConfirmed = true) {
  return {
    signInWithPassword: async () => ({ supabaseUserId, email: "invitee@example.com", provider: "email" as const, emailConfirmed }),
    startGitHubOAuth: () => ({ authorizationUrl: "https://example.invalid", flowId: "flow", flowCookie: "cookie" }),
    completeGitHubOAuth: async () => ({ supabaseUserId, email: "invitee@example.com", provider: "github" as const, emailConfirmed }),
  };
}

async function withServer(database: ProductDatabase, run: (baseUrl: string) => Promise<void>, emailConfirmed = true): Promise<void> {
  const server = createApiServer({
    webOrigin: "http://localhost:3000",
    apiOrigin: "http://localhost:3001",
    sessionSecret,
    sessionDurationMs: 60_000,
    onboardingDurationMs: 600_000,
    auth: auth(emailConfirmed),
    database,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { server.close(); await once(server, "close"); }
}

function onboardingCookie(emailConfirmed = true): string {
  const identity = { supabaseUserId, email: "invitee@example.com", expiresAtMs: Date.now() + 60_000, emailConfirmed } as Parameters<typeof createOnboardingToken>[0] & { readonly emailConfirmed: boolean };
  return `onboarding_session=${encodeURIComponent(createOnboardingToken(identity, sessionSecret))}`;
}

function tenantCookie(): string {
  return `tenant_session=${encodeURIComponent(createSessionToken({ userId, organizationId, expiresAtMs: Date.now() + 60_000 }, sessionSecret))}`;
}

describe("invitation API flow", () => {
  it("redirects a confirmed first-time user with a matching invite to the invite chooser", async () => {
    await withServer(baseDatabase(), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/auth/email`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ email: "invitee@example.com", password: "password" }),
        redirect: "manual",
      });
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("http://localhost:3000/invites");
      expect(response.headers.get("set-cookie")).toContain("onboarding_session=");
    });
  });

  it("does not route an unconfirmed identity into invite acceptance", async () => {
    let listed = 0;
    const database = baseDatabase({ listVerifiedInvitations: async () => { listed += 1; return []; } });
    await withServer(database, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/auth/email`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ email: "invitee@example.com", password: "password" }),
        redirect: "manual",
      });
      expect(response.headers.get("location")).toBe("http://localhost:3000/onboarding");
      expect(listed).toBe(0);
    }, false);
  });

  it("lists only verified invitations through the onboarding session", async () => {
    await withServer(baseDatabase(), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/invitations`, { headers: { cookie: onboardingCookie() } });
      expect(response.status).toBe(200);
      const payload = await response.json() as { invitations: Invite[] };
      expect(payload.invitations).toHaveLength(1);
      expect(payload.invitations[0]?.id).toBe(inviteId);
      expect(payload.invitations[0]?.organizationName).toBe("Acme");
    });
  });

  it("accepts a specific invitation, clears onboarding and issues the tenant session", async () => {
    let accepted = "";
    const database = baseDatabase({ acceptVerifiedInvitation: async (_identity, id) => { accepted = id; return { userId, organizationId }; } });
    await withServer(database, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/invitations/accept`, {
        method: "POST",
        headers: { cookie: onboardingCookie(), "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ invitationId: inviteId }),
        redirect: "manual",
      });
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("http://localhost:3000/home");
      expect(response.headers.get("set-cookie")).toContain("tenant_session=");
      expect(response.headers.get("set-cookie")).toContain("onboarding_session=;");
      expect(accepted).toBe(inviteId);
    });
  });

  it("declines without consuming the invite by clearing onboarding and returning to login", async () => {
    await withServer(baseDatabase(), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/invitations/decline`, { method: "POST", headers: { cookie: onboardingCookie() }, redirect: "manual" });
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("http://localhost:3000");
      expect(response.headers.get("set-cookie")).toContain("onboarding_session=;");
    });
  });

  it("lets a signed-in owner create only developer or rep invitations", async () => {
    let created: { email: string; role: string } | null = null;
    const database = baseDatabase({ createInvitation: async (_session, email, role) => { created = { email, role }; return {}; } });
    await withServer(database, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/members/invitations`, {
        method: "POST",
        headers: { cookie: tenantCookie(), "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ email: " Dev@Example.com ", role: "developer" }),
        redirect: "manual",
      });
      expect(response.status).toBe(303);
      expect(new URL(response.headers.get("location")!).pathname).toBe("/members");
      expect(created).toEqual({ email: "dev@example.com", role: "developer" });
    });
  });
});

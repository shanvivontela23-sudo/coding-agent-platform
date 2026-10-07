import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { createSessionToken } from "../src/auth.js";
import { createApiServer } from "../src/server.js";
import type { MemberRole, ProductDatabase } from "../src/database.js";

const sessionSecret = "test-session-secret-that-is-long-enough";
const userId = "10000000-0000-4000-8000-000000000061";
const organizationId = "00000000-0000-4000-8000-000000000061";

function database(role: MemberRole): ProductDatabase {
  return {
    lookupMemberships: async () => [],
    createOrganizationWithOwner: async () => ({ userId, organizationId }),
    getHome: async () => ({ organization: { id: organizationId, name: "Acme" }, user: { id: userId, email: "member@example.com" }, projects: [] }),
    getMembers: async () => ({
      organization: { id: organizationId, name: "Acme" },
      currentUser: { id: userId, email: "member@example.com", role },
      members: [{ id: userId, email: "member@example.com", role }],
      invitations: [{ id: "70000000-0000-4000-8000-000000000061", email: "pending@example.com", role: "developer", expiresAt: "2026-10-14T00:00:00.000Z" }],
    }),
    createInvitation: async (_session, email, inviteRole) => ({ id: "70000000-0000-4000-8000-000000000061", organizationId, organizationName: "Acme", email, role: inviteRole, expiresAt: "2026-10-14T00:00:00.000Z" }),
    listVerifiedInvitations: async () => [],
    acceptVerifiedInvitation: async () => ({ userId, organizationId }),
  };
}

async function getMembers(role: MemberRole): Promise<{ invitations: unknown[] }> {
  const server = createApiServer({
    webOrigin: "http://localhost:3000",
    apiOrigin: "http://localhost:3001",
    sessionSecret,
    sessionDurationMs: 60_000,
    onboardingDurationMs: 600_000,
    auth: {
      signInWithPassword: async () => ({ supabaseUserId: "60000000-0000-4000-8000-000000000061", email: "member@example.com", provider: "email" as const }),
      startGitHubOAuth: () => ({ authorizationUrl: "https://example.invalid", flowId: "flow", flowCookie: "cookie" }),
      completeGitHubOAuth: async () => ({ supabaseUserId: "60000000-0000-4000-8000-000000000061", email: "member@example.com", provider: "github" as const }),
    },
    database: database(role),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  try {
    const token = createSessionToken({ userId, organizationId, expiresAtMs: Date.now() + 60_000 }, sessionSecret);
    const response = await fetch(`http://127.0.0.1:${address.port}/api/members`, { headers: { cookie: `tenant_session=${encodeURIComponent(token)}` } });
    expect(response.status).toBe(200);
    return await response.json() as { invitations: unknown[] };
  } finally {
    server.close();
    await once(server, "close");
  }
}

describe("members API pending invitation visibility", () => {
  it("returns pending invitations to owners", async () => {
    expect((await getMembers("owner")).invitations).toHaveLength(1);
  });

  it.each(["developer", "rep"] as const)("returns no pending invitations to %s members", async (role) => {
    expect((await getMembers(role)).invitations).toEqual([]);
  });
});
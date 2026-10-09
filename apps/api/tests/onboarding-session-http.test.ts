import { once } from "node:events";
import type { Server } from "node:http";
import { describe, expect, it } from "vitest";
import { createOnboardingToken } from "../src/auth.js";
import type { ProductDatabase } from "../src/database.js";
import { createApiServer } from "../src/server.js";

const sessionSecret = "onboarding-session-http-secret-long-enough";
const supabaseUserId = "60000000-0000-4000-8000-0000000000d1";

function database(): ProductDatabase {
  return {
    lookupMemberships: async () => [],
    createOrganizationWithOwner: async () => ({
      userId: "10000000-0000-4000-8000-0000000000d1",
      organizationId: "00000000-0000-4000-8000-0000000000d1",
    }),
    getHome: async () => ({
      organization: { id: "00000000-0000-4000-8000-0000000000d1", name: "Acme" },
      user: { id: "10000000-0000-4000-8000-0000000000d1", email: "owner@example.com" },
      projects: [],
    }),
    getMembers: async () => ({
      organization: { id: "00000000-0000-4000-8000-0000000000d1", name: "Acme" },
      currentUser: { id: "10000000-0000-4000-8000-0000000000d1", email: "owner@example.com", role: "owner" },
      members: [],
      invitations: [],
    }),
    createInvitation: async () => { throw new Error("not used"); },
    listVerifiedInvitations: async () => [],
    acceptVerifiedInvitation: async () => ({
      userId: "10000000-0000-4000-8000-0000000000d1",
      organizationId: "00000000-0000-4000-8000-0000000000d1",
    }),
  };
}

function server(): Server {
  return createApiServer({
    webOrigin: "http://localhost:3000",
    apiOrigin: "http://localhost:3001",
    sessionSecret,
    sessionDurationMs: 60_000,
    onboardingDurationMs: 60_000,
    auth: {
      signInWithPassword: async () => { throw new Error("not used"); },
      startGitHubOAuth: () => { throw new Error("not used"); },
      completeGitHubOAuth: async () => { throw new Error("not used"); },
    },
    database: database(),
  });
}

async function withServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const api = server();
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  const address = api.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { api.close(); await once(api, "close"); }
}

async function expectAuthRequired(response: Response): Promise<void> {
  expect(response.status).toBe(401);
  await expect(response.json()).resolves.toEqual({
    code: "AUTH_REQUIRED",
    error: "Please sign in to continue.",
  });
}

describe("onboarding session HTTP authentication", () => {
  it("returns AUTH_REQUIRED for GET /api/invitations with no onboarding cookie", async () => {
    await withServer(async (baseUrl) => {
      await expectAuthRequired(await fetch(`${baseUrl}/api/invitations`));
    });
  });

  it("returns AUTH_REQUIRED for GET /api/invitations with an expired onboarding cookie", async () => {
    const expired = createOnboardingToken({
      supabaseUserId,
      email: "invitee@example.com",
      emailConfirmed: true,
      expiresAtMs: Date.now() - 1_000,
    }, sessionSecret);

    await withServer(async (baseUrl) => {
      await expectAuthRequired(await fetch(`${baseUrl}/api/invitations`, {
        headers: { cookie: `onboarding_session=${encodeURIComponent(expired)}` },
      }));
    });
  });

  it("redirects onboarding POST routes to sign-in when the session is missing", async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/invitations/accept`, {
        method: "POST",
        body: new URLSearchParams({ invitationId: "70000000-0000-4000-8000-0000000000d1" }),
        redirect: "manual",
      });
      expect(response.status).toBe(303);
      const location = new URL(response.headers.get("location")!);
      expect(location.pathname).toBe("/");
      expect(location.searchParams.get("error")).toBe("Please sign in to continue.");
    });
  });
});

import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiServer } from "../src/server.js";
import type { ProductDatabase } from "../src/database.js";

const sessionSecret = "test-session-secret-that-is-long-enough";
const providerDetail = "provider rejected test credential";
const userId = "10000000-0000-4000-8000-000000000041";
const organizationId = "00000000-0000-4000-8000-000000000041";

function database(): ProductDatabase {
  return {
    lookupMemberships: async () => [],
    createOrganizationWithOwner: async () => ({ userId, organizationId }),
    getHome: async () => ({ organization: { id: organizationId, name: "Acme" }, user: { id: userId, email: "owner@example.com" }, projects: [] }),
    getMembers: async () => ({ organization: { id: organizationId, name: "Acme" }, currentUser: { id: userId, email: "owner@example.com", role: "owner" }, members: [], invitations: [] }),
    createInvitation: async (_session, email, role) => ({ id: "70000000-0000-4000-8000-000000000041", organizationId, organizationName: "Acme", email, role, expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    listVerifiedInvitations: async () => [],
    acceptVerifiedInvitation: async () => ({ userId, organizationId }),
  };
}

afterEach(() => vi.restoreAllMocks());

describe("API caught-error logging", () => {
  it("logs the real error details and a short request reference without request metadata", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const server = createApiServer({
      webOrigin: "http://localhost:3000",
      apiOrigin: "http://localhost:3001",
      sessionSecret,
      sessionDurationMs: 60_000,
      onboardingDurationMs: 600_000,
      auth: {
        signInWithPassword: async () => { throw new Error(providerDetail); },
        startGitHubOAuth: () => ({ authorizationUrl: "https://example.invalid", flowId: "flow", flowCookie: "cookie" }),
        completeGitHubOAuth: async () => { throw new Error("unused"); },
      },
      database: database(),
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    try {
      await fetch(`http://127.0.0.1:${address.port}/auth/email`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ email: "rep@example.com", password: "test-password" }),
        redirect: "manual",
      });
      expect(error).toHaveBeenCalledTimes(1);
      const raw = String(error.mock.calls[0]?.[0]);
      const entry = JSON.parse(raw) as Record<string, unknown>;
      expect(entry).toMatchObject({ event: "api_error", method: "POST", path: "/auth/email", code: "AUTH_SIGN_IN_FAILED" });
      expect(entry.requestId).toMatch(/^[0-9a-f]{6}$/);
      expect(entry.code).toMatch(/^[A-Z0-9_]{3,48}$/);
      expect(entry.error).toMatchObject({ name: "Error", message: providerDetail });
      expect(String((entry.error as { stack?: unknown }).stack)).toContain(providerDetail);
      expect(entry).not.toHaveProperty("body");
      expect(entry).not.toHaveProperty("cookie");
      expect(entry).not.toHaveProperty("authorization");
    } finally {
      server.close();
      await once(server, "close");
    }
  });
});

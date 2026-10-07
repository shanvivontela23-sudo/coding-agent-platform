import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiServer } from "../src/server.js";
import type { ProductDatabase } from "../src/database.js";

const sessionSecret = "test-session-secret-that-is-long-enough";
const secretPassword = "dont-log-this-password";

function database(): ProductDatabase {
  return {
    lookupMemberships: async () => [],
    createOrganizationWithOwner: async () => ({ userId: "10000000-0000-4000-8000-000000000041", organizationId: "00000000-0000-4000-8000-000000000041" }),
    getHome: async () => ({ organization: { id: "00000000-0000-4000-8000-000000000041", name: "Acme" }, projects: [] }),
  };
}

afterEach(() => vi.restoreAllMocks());

describe("API caught-error logging", () => {
  it("logs one structured server-side event without request secrets or raw error messages", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const server = createApiServer({
      webOrigin: "http://localhost:3000",
      apiOrigin: "http://localhost:3001",
      sessionSecret,
      sessionDurationMs: 60_000,
      onboardingDurationMs: 600_000,
      auth: {
        signInWithPassword: async () => { throw new Error(`provider rejected ${secretPassword}`); },
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
        body: new URLSearchParams({ email: "rep@example.com", password: secretPassword }),
        redirect: "manual",
      });
      expect(error).toHaveBeenCalledTimes(1);
      const raw = String(error.mock.calls[0]?.[0]);
      const entry = JSON.parse(raw) as Record<string, unknown>;
      expect(entry).toMatchObject({ event: "api_error", method: "POST", path: "/auth/email" });
      expect(raw).not.toContain(secretPassword);
      expect(raw).not.toContain("provider rejected");
      expect(entry).not.toHaveProperty("body");
      expect(entry).not.toHaveProperty("cookie");
      expect(entry).not.toHaveProperty("authorization");
    } finally {
      server.close();
      await once(server, "close");
    }
  });
});

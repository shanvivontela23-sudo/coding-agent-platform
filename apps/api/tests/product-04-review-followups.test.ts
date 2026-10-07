import { once } from "node:events";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSupabaseAuthClient } from "../src/auth.js";
import { createProductDatabase, type ProductDatabase, type TenantClient, type TenantPool } from "../src/database.js";
import { createApiServer } from "../src/server.js";

// RED contract for review follow-ups; production changes land only after this fails for the requested behavior.
const supabaseUrl = "https://project-ref.supabase.co";
const anonKey = "sb_publishable_test";
const flowSecret = "test-flow-secret-that-is-long-enough";
const sessionSecret = "test-session-secret-that-is-long-enough";
const userId = "10000000-0000-4000-8000-000000000071";
const organizationId = "00000000-0000-4000-8000-000000000071";

function serverDatabase(): ProductDatabase {
  return {
    lookupMemberships: async () => [],
    createOrganizationWithOwner: async () => ({ userId, organizationId }),
    getHome: async () => ({ organization: { id: organizationId, name: "Acme" }, user: { id: userId, email: "owner@example.com" }, projects: [] }),
    getMembers: async () => ({ organization: { id: organizationId, name: "Acme" }, currentUser: { id: userId, email: "owner@example.com", role: "owner" }, members: [], invitations: [] }),
    createInvitation: async (_session, email, role) => ({ id: "70000000-0000-4000-8000-000000000071", organizationId, organizationName: "Acme", email, role, expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    listVerifiedInvitations: async () => [],
    acceptVerifiedInvitation: async () => ({ userId, organizationId }),
  };
}

afterEach(() => vi.restoreAllMocks());

describe("Product 04 review follow-ups", () => {
  it("derives emailConfirmed from email_confirmed_at only", async () => {
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({
      access_token: "supabase-access-token",
      user: {
        id: "33333333-3333-4333-8333-333333333333",
        email: "invitee@example.com",
        confirmed_at: "2026-10-07T12:00:00Z",
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
    const client = createSupabaseAuthClient({ supabaseUrl, anonKey, flowSecret, fetchImpl });
    await expect(client.signInWithPassword("invitee@example.com", "password")).resolves.toEqual({
      supabaseUserId: "33333333-3333-4333-8333-333333333333",
      email: "invitee@example.com",
      provider: "email",
    });
  });

  it("does not query or return pending invitations for a non-owner member", async () => {
    let invitationQueries = 0;
    const client: TenantClient = {
      async query<Row>(text: string): Promise<{ rows: Row[] }> {
        if (text.includes("FROM organizations")) return { rows: [{ id: organizationId, name: "Acme" } as Row] };
        if (text.includes("m.user_id = $2")) return { rows: [{ id: userId, email: "dev@example.com", role: "developer" } as Row] };
        if (text.includes("FROM organization_memberships AS m")) return { rows: [{ id: userId, email: "dev@example.com", role: "developer" } as Row] };
        if (text.includes("FROM organization_invitations")) {
          invitationQueries += 1;
          return { rows: [{ id: "70000000-0000-4000-8000-000000000071", email: "pending@example.com", role: "rep", expires_at: new Date(Date.now() + 60_000) } as Row] };
        }
        return { rows: [] };
      },
      release() {},
    };
    const pool: TenantPool = {
      connect: async () => client,
      query: async () => ({ rows: [] }),
    };
    const db = createProductDatabase(pool);
    const result = await db.getMembers({ userId, organizationId, expiresAtMs: Date.now() + 60_000 });
    expect(result.currentUser.role).toBe("developer");
    expect(result.invitations).toEqual([]);
    expect(invitationQueries).toBe(0);
  });

  it("logs a short safe code for caught failures and never the raw message", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const server = createApiServer({
      webOrigin: "http://localhost:3000",
      apiOrigin: "http://localhost:3001",
      sessionSecret,
      sessionDurationMs: 60_000,
      onboardingDurationMs: 600_000,
      auth: {
        signInWithPassword: async () => { throw new Error("provider raw secret detail"); },
        startGitHubOAuth: () => ({ authorizationUrl: "https://example.invalid", flowId: "flow", flowCookie: "cookie" }),
        completeGitHubOAuth: async () => { throw new Error("unused"); },
      },
      database: serverDatabase(),
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    try {
      await fetch(`http://127.0.0.1:${address.port}/auth/email`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ email: "rep@example.com", password: "secret-password" }),
        redirect: "manual",
      });
      const raw = String(error.mock.calls[0]?.[0]);
      const entry = JSON.parse(raw) as Record<string, unknown>;
      expect(entry).toMatchObject({ event: "api_error", method: "POST", path: "/auth/email", code: "auth_failed" });
      expect(raw).not.toContain("provider raw secret detail");
      expect(raw).not.toContain("secret-password");
      expect(entry).not.toHaveProperty("errorType");
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("protects every SQL migration with the exact checksum manifest", async () => {
    const directory = "packages/db/migrations";
    const files = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
    const manifest = JSON.parse(await readFile(`${directory}/checksums.json`, "utf8")) as Record<string, string>;
    expect(Object.keys(manifest).sort()).toEqual(files);
    for (const file of files) {
      const digest = createHash("sha256").update(await readFile(`${directory}/${file}`)).digest("hex");
      expect(manifest[file]).toBe(digest);
    }
  });
});

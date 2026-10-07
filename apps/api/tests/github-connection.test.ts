import { createHash } from "node:crypto";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { createSessionToken, type SessionIdentity } from "../src/auth.js";
import { createApiServer, type ApiServerOptions } from "../src/server.js";
import type { MemberRole, ProductDatabase } from "../src/database.js";

const sessionSecret = "test-session-secret-that-is-long-enough";
const userId = "10000000-0000-4000-8000-000000000071";
const organizationId = "00000000-0000-4000-8000-000000000071";
const session: SessionIdentity = { userId, organizationId, expiresAtMs: Date.now() + 60_000 };

type ExtendedDatabase = ProductDatabase & {
  getMembershipRole(session: SessionIdentity): Promise<MemberRole>;
  createGitHubConnectionState(session: SessionIdentity, nonceHash: string, expiresAt: Date): Promise<void>;
  consumeGitHubConnectionState(session: SessionIdentity, nonceHash: string, now: Date): Promise<boolean>;
  bindGitHubInstallation(session: SessionIdentity, installationId: number): Promise<void>;
};

type FakeGitHub = {
  installationUrl(state: string): string;
  verifyUserInstallation(code: string, installationId: number): Promise<void>;
};

function makeDatabase(options: { role?: MemberRole; boundElsewhere?: boolean } = {}) {
  const states = new Set<string>();
  const bindings: number[] = [];
  const role = options.role ?? "owner";
  const database = {
    lookupMemberships: async () => [],
    createOrganizationWithOwner: async () => ({ userId, organizationId }),
    getHome: async () => ({ organization: { id: organizationId, name: "Acme" }, user: { id: userId, email: "owner@example.com" }, projects: [] }),
    getMembers: async () => ({ organization: { id: organizationId, name: "Acme" }, currentUser: { id: userId, email: "owner@example.com", role }, members: [], invitations: [] }),
    createInvitation: async (_session: SessionIdentity, email: string, inviteRole: "developer" | "rep") => ({ id: "70000000-0000-4000-8000-000000000071", organizationId, organizationName: "Acme", email, role: inviteRole, expiresAt: "2026-10-14T00:00:00.000Z" }),
    listVerifiedInvitations: async () => [],
    acceptVerifiedInvitation: async () => ({ userId, organizationId }),
    getMembershipRole: async () => role,
    createGitHubConnectionState: async (_session: SessionIdentity, nonceHash: string) => { states.add(nonceHash); },
    consumeGitHubConnectionState: async (_session: SessionIdentity, nonceHash: string) => {
      if (!states.has(nonceHash)) return false;
      states.delete(nonceHash);
      return true;
    },
    bindGitHubInstallation: async (_session: SessionIdentity, installationId: number) => {
      if (options.boundElsewhere) throw Object.assign(new Error("must never be logged"), { code: "GITHUB_INSTALLATION_BOUND" });
      bindings.push(installationId);
    },
  } as unknown as ExtendedDatabase;
  return { database, bindings };
}

function makeGitHub() {
  const verified: number[] = [];
  const github: FakeGitHub = {
    installationUrl: (state) => `https://github.com/apps/dhara-test/installations/new?state=${encodeURIComponent(state)}`,
    verifyUserInstallation: async (_code, installationId) => {
      verified.push(installationId);
      if (installationId !== 42) throw Object.assign(new Error("forged installation"), { code: "GITHUB_INSTALLATION_FORBIDDEN" });
    },
  };
  return { github, verified };
}

async function withServer(database: ExtendedDatabase, github: FakeGitHub, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const options = {
    webOrigin: "http://localhost:3000",
    apiOrigin: "http://localhost:3001",
    sessionSecret,
    sessionDurationMs: 60_000,
    onboardingDurationMs: 600_000,
    auth: {
      signInWithPassword: async () => ({ supabaseUserId: "60000000-0000-4000-8000-000000000071", email: "owner@example.com", provider: "email" as const }),
      startGitHubOAuth: () => ({ authorizationUrl: "https://example.invalid", flowId: "flow", flowCookie: "cookie" }),
      completeGitHubOAuth: async () => ({ supabaseUserId: "60000000-0000-4000-8000-000000000071", email: "owner@example.com", provider: "github" as const }),
    },
    database,
    githubApp: github,
    nowMs: () => 1_000_000,
    randomBytes: () => Buffer.alloc(32, 7),
  } as unknown as ApiServerOptions;
  const server = createApiServer(options);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { server.close(); await once(server, "close"); }
}

function tenantCookie(): string {
  return `tenant_session=${encodeURIComponent(createSessionToken(session, sessionSecret))}`;
}

async function begin(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/github/connect/start`, { headers: { cookie: tenantCookie() }, redirect: "manual" });
  expect(response.status).toBe(303);
  const location = response.headers.get("location");
  expect(location).toBeTruthy();
  const state = new URL(location!).searchParams.get("state");
  expect(state).toBeTruthy();
  return state!;
}

describe("GitHub App installation binding", () => {
  it.each(["owner", "developer"] as const)("lets a %s start a signed tenant-bound flow", async (role) => {
    const { database } = makeDatabase({ role });
    const { github } = makeGitHub();
    await withServer(database, github, async (baseUrl) => {
      const state = await begin(baseUrl);
      expect(state.split(".")).toHaveLength(2);
      expect(state).not.toContain(organizationId);
    });
  });

  it("does not let a support rep start repository connection", async () => {
    const { database } = makeDatabase({ role: "rep" });
    const { github } = makeGitHub();
    await withServer(database, github, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/github/connect/start`, { headers: { cookie: tenantCookie() }, redirect: "manual" });
      expect(response.status).toBe(303);
      expect(new URL(response.headers.get("location")!).pathname).toBe("/home");
    });
  });

  it("rejects a forged installation id before binding", async () => {
    const { database, bindings } = makeDatabase();
    const { github, verified } = makeGitHub();
    await withServer(database, github, async (baseUrl) => {
      const state = await begin(baseUrl);
      const response = await fetch(`${baseUrl}/auth/github/installation/callback?state=${encodeURIComponent(state)}&code=user-code&installation_id=999`, { headers: { cookie: tenantCookie() }, redirect: "manual" });
      expect(response.status).toBe(303);
      expect(new URL(response.headers.get("location")!).pathname).toBe("/home");
      expect(verified).toEqual([999]);
      expect(bindings).toEqual([]);
    });
  });

  it("rejects replay of a consumed state before a second GitHub verification", async () => {
    const { database, bindings } = makeDatabase();
    const { github, verified } = makeGitHub();
    await withServer(database, github, async (baseUrl) => {
      const state = await begin(baseUrl);
      const callback = `${baseUrl}/auth/github/installation/callback?state=${encodeURIComponent(state)}&code=user-code&installation_id=42`;
      const first = await fetch(callback, { headers: { cookie: tenantCookie() }, redirect: "manual" });
      expect(first.status).toBe(303);
      expect(new URL(first.headers.get("location")!).pathname).toBe("/github/repositories");
      const replay = await fetch(callback, { headers: { cookie: tenantCookie() }, redirect: "manual" });
      expect(replay.status).toBe(303);
      expect(new URL(replay.headers.get("location")!).pathname).toBe("/home");
      expect(verified).toEqual([42]);
      expect(bindings).toEqual([42]);
    });
  });

  it("rejects an installation already bound to another organization", async () => {
    const { database, bindings } = makeDatabase({ boundElsewhere: true });
    const { github } = makeGitHub();
    await withServer(database, github, async (baseUrl) => {
      const state = await begin(baseUrl);
      const response = await fetch(`${baseUrl}/auth/github/installation/callback?state=${encodeURIComponent(state)}&code=user-code&installation_id=42`, { headers: { cookie: tenantCookie() }, redirect: "manual" });
      expect(response.status).toBe(303);
      expect(new URL(response.headers.get("location")!).pathname).toBe("/home");
      expect(bindings).toEqual([]);
    });
  });

  it("binds an already-installed app after configure when user access is verified", async () => {
    const { database, bindings } = makeDatabase();
    const { github } = makeGitHub();
    await withServer(database, github, async (baseUrl) => {
      const state = await begin(baseUrl);
      const response = await fetch(`${baseUrl}/auth/github/installation/callback?state=${encodeURIComponent(state)}&code=user-code&installation_id=42&setup_action=update`, { headers: { cookie: tenantCookie() }, redirect: "manual" });
      expect(new URL(response.headers.get("location")!).pathname).toBe("/github/repositories");
      expect(bindings).toEqual([42]);
    });
  });

  it("shows waiting state and binds nothing when GitHub installation approval is pending", async () => {
    const { database, bindings } = makeDatabase();
    const { github, verified } = makeGitHub();
    await withServer(database, github, async (baseUrl) => {
      const state = await begin(baseUrl);
      const response = await fetch(`${baseUrl}/auth/github/installation/callback?state=${encodeURIComponent(state)}&code=user-code&setup_action=request`, { headers: { cookie: tenantCookie() }, redirect: "manual" });
      const location = new URL(response.headers.get("location")!);
      expect(location.pathname).toBe("/github/repositories");
      expect(location.searchParams.get("status")).toBe("pending");
      expect(verified).toEqual([]);
      expect(bindings).toEqual([]);
    });
  });

  it("persists only a nonce hash for connection state", async () => {
    const seen: string[] = [];
    const { database } = makeDatabase();
    const original = database.createGitHubConnectionState.bind(database);
    database.createGitHubConnectionState = async (tenant, nonceHash, expiresAt) => { seen.push(nonceHash); await original(tenant, nonceHash, expiresAt); };
    const { github } = makeGitHub();
    await withServer(database, github, async (baseUrl) => {
      const state = await begin(baseUrl);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatch(/^[0-9a-f]{64}$/);
      expect(seen[0]).toBe(createHash("sha256").update(Buffer.alloc(32, 7).toString("base64url")).digest("hex"));
      expect(state).not.toContain(seen[0]!);
    });
  });
});
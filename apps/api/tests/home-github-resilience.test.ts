import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { createSessionToken, type SessionIdentity } from "../src/auth.js";
import type { ProductDatabase } from "../src/database.js";
import type { GitHubAppClient } from "../src/github-app.js";
import { createApiServer, type ApiServerOptions } from "../src/server.js";

const sessionSecret = "test-session-secret-that-is-long-enough";
const userId = "10000000-0000-4000-8000-0000000000a1";
const organizationId = "00000000-0000-4000-8000-0000000000a1";
const session: SessionIdentity = { userId, organizationId, expiresAtMs: Date.now() + 60_000 };

function database(): ProductDatabase {
  return {
    lookupMemberships: async () => [],
    createOrganizationWithOwner: async () => ({ userId, organizationId }),
    getHome: async () => ({
      organization: { id: organizationId, name: "Acme" },
      user: { id: userId, email: "owner@example.com" },
      projects: [{ id: "20000000-0000-4000-8000-0000000000a1", name: "API", source: { type: "github", fullName: "acme/api", defaultBranch: "main" } }],
    }),
    getMembers: async () => ({ organization: { id: organizationId, name: "Acme" }, currentUser: { id: userId, email: "owner@example.com", role: "owner" }, members: [], invitations: [] }),
    createInvitation: async () => { throw new Error("not used"); },
    listVerifiedInvitations: async () => [],
    acceptVerifiedInvitation: async () => ({ userId, organizationId }),
    getGitHubInstallation: async () => ({ installationId: 42, status: "connected", accountLogin: "acme" }),
  } as unknown as ProductDatabase;
}

function github(getInstallationDetails: () => Promise<{ accountLogin: string; managementUrl: string }>): GitHubAppClient {
  return {
    installationUrl: () => "https://github.com/apps/dhara-test/installations/new",
    verifyUserInstallation: async () => undefined,
    getInstallationDetails,
    listRepositories: async () => [],
    analyseRepository: async () => { throw new Error("not used"); },
    checkInstallation: async () => undefined,
  } as unknown as GitHubAppClient;
}

async function withServer(options: { githubApp: GitHubAppClient; nowMs?: () => number; timeoutMs?: number }, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = createApiServer({
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
    githubApp: options.githubApp,
    nowMs: options.nowMs,
    githubInstallationDetailsTimeoutMs: options.timeoutMs,
  } as unknown as ApiServerOptions);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { server.close(); await once(server, "close"); }
}

function tenantHeaders(): HeadersInit {
  return { cookie: `tenant_session=${encodeURIComponent(createSessionToken(session, sessionSecret))}` };
}

async function home(baseUrl: string): Promise<Response> {
  return await fetch(`${baseUrl}/api/home`, { headers: tenantHeaders() });
}

describe("home GitHub resilience", () => {
  it("returns home projects with unknown GitHub state when installation details fail", async () => {
    await withServer({ githubApp: github(async () => { throw new Error("GitHub 500"); }) }, async (baseUrl) => {
      const response = await home(baseUrl);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        projects: [{ name: "API" }],
        github: { status: "unknown", accountLogin: "acme", managementUrl: null },
      });
    });
  });

  it("returns home projects when the GitHub details call times out", async () => {
    await withServer({
      githubApp: github(async () => await new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("slow GitHub failure")), 100))),
      timeoutMs: 20,
    }, async (baseUrl) => {
      const startedAt = Date.now();
      const response = await home(baseUrl);
      expect(Date.now() - startedAt).toBeLessThan(80);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ projects: [{ name: "API" }], github: { status: "unknown", accountLogin: "acme" } });
    });
  });

  it("caches successful installation details for five minutes per installation", async () => {
    let nowMs = 1_000;
    let calls = 0;
    await withServer({
      githubApp: github(async () => {
        calls += 1;
        return { accountLogin: "acme", managementUrl: "https://github.com/organizations/acme/settings/installations/42" };
      }),
      nowMs: () => nowMs,
    }, async (baseUrl) => {
      expect((await home(baseUrl)).status).toBe(200);
      expect((await home(baseUrl)).status).toBe(200);
      expect(calls).toBe(1);
      nowMs += 5 * 60_000 + 1;
      expect((await home(baseUrl)).status).toBe(200);
      expect(calls).toBe(2);
    });
  });
});

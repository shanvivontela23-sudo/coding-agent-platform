import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createInstallStateToken, type GitHubAppClient } from "../src/github-app.js";
import { createSessionToken, type SessionIdentity, type SupabaseAuthClient } from "../src/auth.js";
import type { GitHubDatabase, ProductDatabase } from "../src/database.js";
import { ApiError } from "../src/errors.js";
import { createApiServer } from "../src/server.js";

const sessionSecret = "test-session-secret-that-is-long-enough";
const stateSecret = "github-state-secret-that-is-long-enough";
const session: SessionIdentity = {
  userId: "10000000-0000-4000-8000-000000000091",
  organizationId: "00000000-0000-4000-8000-000000000091",
  expiresAtMs: Date.now() + 60_000,
};
const stateId = "90000000-0000-4000-8000-000000000091";

function baseDatabase(): ProductDatabase {
  return {
    lookupMemberships: async () => [],
    createOrganizationWithOwner: async () => ({ userId: session.userId, organizationId: session.organizationId }),
    getHome: async () => ({ organization: { id: session.organizationId, name: "Acme" }, user: { id: session.userId, email: "dev@example.com" }, projects: [] }),
    getMembers: async () => ({ organization: { id: session.organizationId, name: "Acme" }, currentUser: { id: session.userId, email: "dev@example.com", role: "developer" }, members: [], invitations: [] }),
    createInvitation: async (_session, email, role) => ({ id: stateId, organizationId: session.organizationId, organizationName: "Acme", email, role, expiresAt: new Date().toISOString() }),
    listVerifiedInvitations: async () => [],
    acceptVerifiedInvitation: async () => ({ userId: session.userId, organizationId: session.organizationId }),
  };
}

function githubDatabase(overrides: Partial<GitHubDatabase> = {}): ProductDatabase & GitHubDatabase {
  return {
    ...baseDatabase(),
    getCurrentMemberRole: async () => "developer",
    createGitHubInstallState: async () => ({ id: stateId, expiresAtMs: Date.now() + 600_000 }),
    consumeGitHubInstallState: async () => undefined,
    bindGitHubInstallation: async () => undefined,
    getGitHubInstallation: async () => 123,
    createProjectFromRepository: async () => ({ projectId: "20000000-0000-4000-8000-000000000091" }),
    getProject: async () => ({
      organization: { id: session.organizationId, name: "Acme" },
      user: { id: session.userId, email: "dev@example.com" },
      project: {
        id: "20000000-0000-4000-8000-000000000091",
        name: "repo",
        repository: { id: "30000000-0000-4000-8000-000000000091", externalId: "77", fullName: "acme/repo", defaultBranch: "main", lastAnalyzedCommitSha: "a".repeat(40) },
        report: { languages: [], frameworks: [], packageManager: null, buildCommand: null, testCommand: null, stackSkill: "generic" },
      },
    }),
    ...overrides,
  };
}

function githubClient(overrides: Partial<GitHubAppClient> = {}): GitHubAppClient {
  return {
    installationUrl: (state) => `https://github.com/apps/dhara/installations/new?state=${encodeURIComponent(state)}`,
    exchangeUserCode: async () => "user-secret-token",
    listUserInstallations: async () => [123],
    mintInstallationToken: async () => "installation-secret-token",
    listInstallationRepositories: async () => [{ id: 77, name: "repo", fullName: "acme/repo", defaultBranch: "main", private: true }],
    loadRepositorySnapshot: async () => ({
      repository: { id: 77, name: "repo", fullName: "acme/repo", defaultBranch: "main", private: true },
      commitSha: "a".repeat(40),
      snapshot: { tree: [{ path: "src/index.ts", type: "blob" }], files: {} },
    }),
    ...overrides,
  };
}

const auth: SupabaseAuthClient = {
  signInWithPassword: async () => { throw new Error("unused"); },
  startGitHubOAuth: () => ({ authorizationUrl: "https://unused.invalid", flowId: "unused", flowCookie: "unused" }),
  completeGitHubOAuth: async () => { throw new Error("unused"); },
};

async function withServer<T>(database: ProductDatabase & GitHubDatabase, github: GitHubAppClient, run: (origin: string) => Promise<T>): Promise<T> {
  const server = createApiServer({
    webOrigin: "http://localhost:3000",
    apiOrigin: "http://localhost:3001",
    sessionSecret,
    sessionDurationMs: 60_000,
    onboardingDurationMs: 600_000,
    auth,
    database,
    github,
    githubStateSecret: stateSecret,
    githubStateDurationMs: 600_000,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  try { return await run(`http://127.0.0.1:${address.port}`); }
  finally { server.close(); await once(server, "close"); }
}

function tenantCookie(): string {
  return `tenant_session=${encodeURIComponent(createSessionToken(session, sessionSecret))}`;
}

describe("verified GitHub App installation flow", () => {
  it("starts with a DB-backed signed state and a live GitHub install redirect", async () => {
    await withServer(githubDatabase(), githubClient(), async (origin) => {
      const response = await fetch(`${origin}/github/install/start`, { headers: { cookie: tenantCookie() }, redirect: "manual" });
      expect(response.status).toBe(303);
      const location = new URL(response.headers.get("location")!);
      expect(location.hostname).toBe("github.com");
      expect(location.pathname).toContain("/apps/dhara/installations/new");
      expect(location.searchParams.get("state")).toBeTruthy();
    });
  });

  it("rejects a forged installation id even when it arrives with a valid OAuth code and state", async () => {
    let bound: number | null = null;
    const state = createInstallStateToken({ stateId, expiresAtMs: Date.now() + 60_000 }, stateSecret);
    await withServer(githubDatabase({ bindGitHubInstallation: async (_session, id) => { bound = id; } }), githubClient({ listUserInstallations: async () => [123] }), async (origin) => {
      const response = await fetch(`${origin}/github/callback?code=oauth-code&state=${encodeURIComponent(state)}&installation_id=999`, { headers: { cookie: tenantCookie() }, redirect: "manual" });
      expect(response.status).toBe(303);
      expect(bound).toBeNull();
      expect(new URL(response.headers.get("location")!).pathname).toBe("/home");
    });
  });

  it("rejects replayed state before binding a second time", async () => {
    let consumes = 0;
    let binds = 0;
    const database = githubDatabase({
      consumeGitHubInstallState: async () => {
        consumes += 1;
        if (consumes > 1) throw new ApiError("github_state_invalid", 400);
      },
      bindGitHubInstallation: async () => { binds += 1; },
    });
    const state = createInstallStateToken({ stateId, expiresAtMs: Date.now() + 60_000 }, stateSecret);
    await withServer(database, githubClient(), async (origin) => {
      const callback = `${origin}/github/callback?code=oauth-code&state=${encodeURIComponent(state)}&installation_id=123`;
      const first = await fetch(callback, { headers: { cookie: tenantCookie() }, redirect: "manual" });
      const second = await fetch(callback, { headers: { cookie: tenantCookie() }, redirect: "manual" });
      expect(new URL(first.headers.get("location")!).pathname).toBe("/connect/github");
      expect(new URL(second.headers.get("location")!).pathname).toBe("/home");
      expect(binds).toBe(1);
    });
  });

  it("rejects an installation already bound to another organization", async () => {
    const state = createInstallStateToken({ stateId, expiresAtMs: Date.now() + 60_000 }, stateSecret);
    await withServer(githubDatabase({ bindGitHubInstallation: async () => { throw new ApiError("github_installation_conflict", 409); } }), githubClient(), async (origin) => {
      const response = await fetch(`${origin}/github/callback?code=oauth-code&state=${encodeURIComponent(state)}&installation_id=123`, { headers: { cookie: tenantCookie() }, redirect: "manual" });
      expect(response.status).toBe(303);
      expect(new URL(response.headers.get("location")!).pathname).toBe("/home");
    });
  });

  it("lists repository metadata without exposing the installation token", async () => {
    await withServer(githubDatabase(), githubClient(), async (origin) => {
      const response = await fetch(`${origin}/api/github/repositories`, { headers: { cookie: tenantCookie() } });
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain("acme/repo");
      expect(text).not.toContain("installation-secret-token");
      expect(text).not.toContain("user-secret-token");
    });
  });

  it("re-fetches the selected repository, analyzes it deterministically, persists it, and redirects to the project", async () => {
    const createProject = vi.fn(async () => ({ projectId: "20000000-0000-4000-8000-000000000091" }));
    await withServer(githubDatabase({ createProjectFromRepository: createProject }), githubClient({
      loadRepositorySnapshot: async () => ({
        repository: { id: 77, name: "repo", fullName: "acme/repo", defaultBranch: "main", private: true },
        commitSha: "b".repeat(40),
        snapshot: {
          tree: [{ path: "src/index.ts", type: "blob" }, { path: "package.json", type: "blob" }, { path: "pnpm-lock.yaml", type: "blob" }],
          files: { "package.json": JSON.stringify({ scripts: { build: "tsc", test: "vitest run" } }), "pnpm-lock.yaml": "lockfileVersion: '9.0'" },
        },
      }),
    }), async (origin) => {
      const response = await fetch(`${origin}/projects`, {
        method: "POST",
        headers: { cookie: tenantCookie(), "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ repositoryId: "77" }),
        redirect: "manual",
      });
      expect(response.status).toBe(303);
      expect(new URL(response.headers.get("location")!).pathname).toBe("/projects/20000000-0000-4000-8000-000000000091");
      expect(createProject).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ repositoryId: 77, fullName: "acme/repo", defaultBranch: "main", commitSha: "b".repeat(40), report: expect.objectContaining({ packageManager: "pnpm", stackSkill: "typescript-node" }) }));
    });
  });
});

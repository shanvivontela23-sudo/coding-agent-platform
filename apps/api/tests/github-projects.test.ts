import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { createSessionToken, type SessionIdentity } from "../src/auth.js";
import { createApiServer, type ApiServerOptions } from "../src/server.js";
import type { ProductDatabase } from "../src/database.js";
import type { ProjectReport } from "../src/repository-analysis.js";

const sessionSecret = "test-session-secret-that-is-long-enough";
const userId = "10000000-0000-4000-8000-000000000091";
const organizationId = "00000000-0000-4000-8000-000000000091";
const projectId = "20000000-0000-4000-8000-000000000091";
const session: SessionIdentity = { userId, organizationId, expiresAtMs: Date.now() + 60_000 };
const report: ProjectReport = {
  languages: [{ name: "TypeScript", fileCount: 3, percentage: 100 }],
  frameworks: ["Next.js", "React"],
  packageManager: "pnpm",
  buildCommand: "pnpm build",
  testCommand: "pnpm test",
  stackSkill: "typescript-node",
  manifests: ["package.json", "pnpm-lock.yaml"],
};

type ExtendedDatabase = ProductDatabase & {
  getMembershipRole(session: SessionIdentity): Promise<"owner" | "developer" | "rep">;
  getGitHubInstallation(session: SessionIdentity): Promise<{ installationId: number; status: "connected" | "disconnected" } | null>;
  markGitHubInstallationDisconnected(session: SessionIdentity): Promise<void>;
  getGitHubProjectBindings(session: SessionIdentity): Promise<ReadonlyArray<{ githubRepositoryId: number; projectId: string }>>;
  createGitHubProject(session: SessionIdentity, input: {
    repositoryId: number;
    name: string;
    fullName: string;
    defaultBranch: string;
    commitSha: string;
    report: ProjectReport;
  }): Promise<{ projectId: string }>;
  getProjectReport(session: SessionIdentity, projectId: string): Promise<{
    project: { id: string; name: string };
    repository: { id: string; githubRepositoryId: number; name: string; fullName: string; defaultBranch: string; lastAnalysedCommit: string };
    report: ProjectReport;
    installation: { installationId: number; status: "connected" | "disconnected" };
  } | null>;
};

type FakeGitHub = {
  installationUrl(state: string): string;
  verifyUserInstallation(code: string, installationId: number): Promise<void>;
  listRepositories(installationId: number): Promise<ReadonlyArray<{ id: number; name: string; fullName: string; defaultBranch: string; private: boolean }>>;
  analyseRepository(installationId: number, repositoryId: number, limits: unknown): Promise<{
    repository: { id: number; name: string; fullName: string; defaultBranch: string; private: boolean };
    commitSha: string;
    report: ProjectReport;
  }>;
  checkInstallation(installationId: number): Promise<void>;
};

function makeDatabase(status: "connected" | "disconnected" = "connected") {
  let disconnected = false;
  let created: Parameters<ExtendedDatabase["createGitHubProject"]>[1] | null = null;
  const database = {
    lookupMemberships: async () => [],
    createOrganizationWithOwner: async () => ({ userId, organizationId }),
    getHome: async () => ({ organization: { id: organizationId, name: "Acme" }, user: { id: userId, email: "owner@example.com" }, projects: [] }),
    getMembers: async () => ({ organization: { id: organizationId, name: "Acme" }, currentUser: { id: userId, email: "owner@example.com", role: "owner" as const }, members: [], invitations: [] }),
    createInvitation: async (_session: SessionIdentity, email: string, role: "developer" | "rep") => ({ id: "70000000-0000-4000-8000-000000000091", organizationId, organizationName: "Acme", email, role, expiresAt: "2026-10-14T00:00:00.000Z" }),
    listVerifiedInvitations: async () => [],
    acceptVerifiedInvitation: async () => ({ userId, organizationId }),
    getMembershipRole: async () => "owner" as const,
    getGitHubInstallation: async () => ({ installationId: 42, status: disconnected ? "disconnected" as const : status }),
    markGitHubInstallationDisconnected: async () => { disconnected = true; },
    getGitHubProjectBindings: async () => [{ githubRepositoryId: 101, projectId }],
    createGitHubProject: async (_session: SessionIdentity, input: Parameters<ExtendedDatabase["createGitHubProject"]>[1]) => { created = input; return { projectId }; },
    getProjectReport: async () => ({
      project: { id: projectId, name: "widget" },
      repository: { id: "30000000-0000-4000-8000-000000000091", githubRepositoryId: 101, name: "widget", fullName: "acme/widget", defaultBranch: "main", lastAnalysedCommit: "a".repeat(40) },
      report,
      installation: { installationId: 42, status: disconnected ? "disconnected" as const : status },
    }),
  } as unknown as ExtendedDatabase;
  return { database, wasDisconnected: () => disconnected, created: () => created };
}

function makeGitHub(options: { disconnectedOnList?: boolean; disconnectedOnCheck?: boolean } = {}) {
  const analysed: number[] = [];
  const github: FakeGitHub = {
    installationUrl: (state) => `https://github.com/apps/dhara-test/installations/new?state=${state}`,
    verifyUserInstallation: async () => undefined,
    listRepositories: async () => {
      if (options.disconnectedOnList) throw Object.assign(new Error("must not surface"), { code: "GITHUB_INSTALLATION_DISCONNECTED" });
      return [
        { id: 101, name: "widget", fullName: "acme/widget", defaultBranch: "main", private: true },
        { id: 102, name: "new-repo", fullName: "acme/new-repo", defaultBranch: "trunk", private: false },
      ];
    },
    analyseRepository: async (_installationId, repositoryId) => {
      analysed.push(repositoryId);
      return {
        repository: { id: 101, name: "widget", fullName: "acme/widget", defaultBranch: "main", private: true },
        commitSha: "a".repeat(40),
        report,
      };
    },
    checkInstallation: async () => {
      if (options.disconnectedOnCheck) throw Object.assign(new Error("gone"), { code: "GITHUB_INSTALLATION_DISCONNECTED" });
    },
  };
  return { github, analysed };
}

function tenantCookie(): string {
  return `tenant_session=${encodeURIComponent(createSessionToken(session, sessionSecret))}`;
}

async function withServer(database: ExtendedDatabase, github: FakeGitHub, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = createApiServer({
    webOrigin: "http://localhost:3000",
    apiOrigin: "http://localhost:3001",
    sessionSecret,
    sessionDurationMs: 60_000,
    onboardingDurationMs: 600_000,
    auth: {
      signInWithPassword: async () => ({ supabaseUserId: "60000000-0000-4000-8000-000000000091", email: "owner@example.com", provider: "email" as const }),
      startGitHubOAuth: () => ({ authorizationUrl: "https://example.invalid", flowId: "flow", flowCookie: "cookie" }),
      completeGitHubOAuth: async () => ({ supabaseUserId: "60000000-0000-4000-8000-000000000091", email: "owner@example.com", provider: "github" as const }),
    },
    database,
    githubApp: github,
  } as unknown as ApiServerOptions);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { server.close(); await once(server, "close"); }
}

describe("GitHub repository selection and project report API", () => {
  it("returns safe repository metadata and marks repositories that already have projects", async () => {
    const { database } = makeDatabase();
    const { github } = makeGitHub();
    await withServer(database, github, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/github/repositories`, { headers: { cookie: tenantCookie() } });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ repositories: [
        { id: 101, name: "widget", fullName: "acme/widget", defaultBranch: "main", private: true, projectId },
        { id: 102, name: "new-repo", fullName: "acme/new-repo", defaultBranch: "trunk", private: false, projectId: null },
      ] });
    });
  });

  it("marks the installation disconnected when minting/listing can no longer authenticate", async () => {
    const { database, wasDisconnected } = makeDatabase();
    const { github } = makeGitHub({ disconnectedOnList: true });
    await withServer(database, github, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/github/repositories`, { headers: { cookie: tenantCookie() } });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "GITHUB_INSTALLATION_DISCONNECTED" });
      expect(wasDisconnected()).toBe(true);
    });
  });

  it("creates a project only from server-revalidated GitHub analysis output", async () => {
    const { database, created } = makeDatabase();
    const { github, analysed } = makeGitHub();
    await withServer(database, github, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/github/projects`, {
        method: "POST",
        headers: { cookie: tenantCookie(), "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ repositoryId: "101", name: "browser-lie", defaultBranch: "evil" }),
        redirect: "manual",
      });
      expect(response.status).toBe(303);
      expect(new URL(response.headers.get("location")!).pathname).toBe(`/projects/${projectId}`);
      expect(analysed).toEqual([101]);
      expect(created()).toMatchObject({ repositoryId: 101, name: "widget", fullName: "acme/widget", defaultBranch: "main", commitSha: "a".repeat(40), report });
      expect(JSON.stringify(created())).not.toContain("browser-lie");
      expect(JSON.stringify(created())).not.toContain("evil");
    });
  });

  it("project reads detect a later uninstall and return reconnect state rather than a raw error", async () => {
    const { database, wasDisconnected } = makeDatabase();
    const { github } = makeGitHub({ disconnectedOnCheck: true });
    await withServer(database, github, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/projects/${projectId}`, { headers: { cookie: tenantCookie() } });
      expect(response.status).toBe(200);
      const payload = await response.json() as { installation: { status: string } };
      expect(payload.installation.status).toBe("disconnected");
      expect(wasDisconnected()).toBe(true);
    });
  });
});

import { describe, expect, it } from "vitest";
import { AppError } from "../src/errors.js";
import { beginGitHubConnection, completeGitHubConnection, listConnectedRepositories } from "../src/github-connection.js";
import type { SessionIdentity } from "../src/auth.js";

const session: SessionIdentity = { userId: "10000000-0000-4000-8000-000000000061", organizationId: "00000000-0000-4000-8000-000000000061", expiresAtMs: Date.now() + 60_000 };
const secret = "github-state-secret-that-is-long-enough";

function fakeDatabase() {
  const consumed = new Set<string>();
  return {
    states: [] as string[],
    bindings: [] as number[],
    disconnected: 0,
    async assertCanConnectRepository() { return "developer" as const; },
    async createGitHubConnectionState(_session: SessionIdentity, nonceHash: string) { this.states.push(nonceHash); },
    async consumeGitHubConnectionState(_session: SessionIdentity, nonceHash: string) { if (consumed.has(nonceHash)) return false; consumed.add(nonceHash); return this.states.includes(nonceHash); },
    async bindGitHubInstallation(_session: SessionIdentity, installationId: number) { this.bindings.push(installationId); },
    async getGitHubInstallation() { return { installationId: 44, status: "connected" as const }; },
    async markGitHubInstallationDisconnected() { this.disconnected += 1; },
  };
}

function fakeGitHub() {
  return {
    exchanged: [] as string[],
    verified: [] as number[],
    installationUrl(state: string) { return `https://github.com/apps/dhara/installations/new?state=${encodeURIComponent(state)}`; },
    async exchangeUserCode(code: string) { this.exchanged.push(code); return "user-token-secret"; },
    async userCanAccessInstallation(_token: string, installationId: number) { this.verified.push(installationId); return installationId === 44; },
    async mintInstallationToken() { return "installation-token-secret"; },
    async listRepositories() { return [{ id: 9, fullName: "acme/app", name: "app", defaultBranch: "main", private: true }]; },
  };
}

describe("GitHub installation binding", () => {
  it("starts with signed single-use state bound to the tenant session", async () => {
    const database = fakeDatabase(); const github = fakeGitHub();
    const started = await beginGitHubConnection({ session, sessionSecret: secret, database, github, nowMs: 1_000, randomBytes: () => Buffer.alloc(32, 7) });
    expect(started.authorizationUrl).toContain("github.com/apps/dhara/installations/new");
    expect(database.states).toHaveLength(1);
    expect(started.state).not.toContain(session.organizationId);
  });

  it("rejects a forged installation id even when the state is valid", async () => {
    const database = fakeDatabase(); const github = fakeGitHub();
    const started = await beginGitHubConnection({ session, sessionSecret: secret, database, github, nowMs: 1_000, randomBytes: () => Buffer.alloc(32, 8) });
    await expect(completeGitHubConnection({ session, sessionSecret: secret, database, github, state: started.state, code: "oauth-code", installationId: 999, setupAction: "install", nowMs: 1_100 })).rejects.toMatchObject({ code: "GITHUB_INSTALLATION_FORBIDDEN" });
    expect(database.bindings).toEqual([]);
  });

  it("rejects replayed state", async () => {
    const database = fakeDatabase(); const github = fakeGitHub();
    const started = await beginGitHubConnection({ session, sessionSecret: secret, database, github, nowMs: 1_000, randomBytes: () => Buffer.alloc(32, 9) });
    await completeGitHubConnection({ session, sessionSecret: secret, database, github, state: started.state, code: "oauth-code", installationId: 44, setupAction: "install", nowMs: 1_100 });
    await expect(completeGitHubConnection({ session, sessionSecret: secret, database, github, state: started.state, code: "oauth-code-2", installationId: 44, setupAction: "install", nowMs: 1_200 })).rejects.toMatchObject({ code: "GITHUB_STATE_REPLAYED" });
  });

  it("propagates the cross-organization binding refusal", async () => {
    const database = { ...fakeDatabase(), async bindGitHubInstallation() { throw new AppError("GITHUB_INSTALLATION_BOUND", 409, "Installation is already connected."); } };
    const github = fakeGitHub();
    const started = await beginGitHubConnection({ session, sessionSecret: secret, database, github, nowMs: 1_000, randomBytes: () => Buffer.alloc(32, 10) });
    await expect(completeGitHubConnection({ session, sessionSecret: secret, database, github, state: started.state, code: "oauth-code", installationId: 44, setupAction: "update", nowMs: 1_100 })).rejects.toMatchObject({ code: "GITHUB_INSTALLATION_BOUND" });
  });

  it("consumes pending-admin state but binds nothing", async () => {
    const database = fakeDatabase(); const github = fakeGitHub();
    const started = await beginGitHubConnection({ session, sessionSecret: secret, database, github, nowMs: 1_000, randomBytes: () => Buffer.alloc(32, 11) });
    await expect(completeGitHubConnection({ session, sessionSecret: secret, database, github, state: started.state, setupAction: "request", nowMs: 1_100 })).resolves.toBe("pending");
    expect(database.bindings).toEqual([]); expect(github.exchanged).toEqual([]);
  });

  it("marks a removed installation disconnected when token minting fails", async () => {
    const database = fakeDatabase();
    const github = { ...fakeGitHub(), async mintInstallationToken() { throw new AppError("GITHUB_INSTALLATION_DISCONNECTED", 409, "Reconnect GitHub."); } };
    await expect(listConnectedRepositories({ session, database, github })).resolves.toEqual({ status: "disconnected", repositories: [] });
    expect(database.disconnected).toBe(1);
  });
});

import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createGitHubAppClient,
  createInstallStateToken,
  selectVerifiedInstallation,
  verifyInstallStateToken,
} from "../src/github-app.js";

const stateSecret = "github-state-secret-that-is-long-enough";
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();

function decodeJwtPart(token: string, index: number): Record<string, unknown> {
  const part = token.split(".")[index];
  if (!part) throw new Error("missing jwt part");
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

describe("GitHub App state", () => {
  it("signs an expiring state id and rejects tampering or expiry", () => {
    const token = createInstallStateToken({ stateId: "90000000-0000-4000-8000-000000000091", expiresAtMs: 61_000 }, stateSecret);
    expect(verifyInstallStateToken(token, stateSecret, 60_000)).toEqual({ stateId: "90000000-0000-4000-8000-000000000091", expiresAtMs: 61_000 });
    expect(() => verifyInstallStateToken(`${token}x`, stateSecret, 60_000)).toThrow();
    expect(() => verifyInstallStateToken(token, stateSecret, 61_000)).toThrow();
  });

  it("rejects a forged installation id and fails closed when the callback is ambiguous", () => {
    expect(() => selectVerifiedInstallation(999, [123, 456], new Set())).toThrow("github_installation_unverified");
    expect(() => selectVerifiedInstallation(null, [123, 456], new Set())).toThrow("github_installation_unverified");
    expect(selectVerifiedInstallation(null, [123], new Set())).toBe(123);
    expect(selectVerifiedInstallation(123, [123, 456], new Set([456]))).toBe(123);
  });
});

describe("GitHub App API client", () => {
  it("uses a short-lived RS256 app JWT, OAuth user token verification, and installation tokens server-side", async () => {
    const calls: Array<{ url: string; headers: Headers; body: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      const body = String(init?.body ?? "");
      calls.push({ url, headers, body });
      if (url.endsWith("/login/oauth/access_token")) return Response.json({ access_token: "user-secret-token" });
      if (url.endsWith("/user/installations?per_page=100")) return Response.json({ installations: [{ id: 123 }, { id: 456 }] });
      if (url.endsWith("/app/installations/123/access_tokens")) return Response.json({ token: "installation-secret-token", expires_at: "2026-10-07T14:00:00Z" });
      if (url.endsWith("/installation/repositories?per_page=100")) return Response.json({ repositories: [{ id: 77, name: "repo", full_name: "acme/repo", default_branch: "main", private: true }] });
      return new Response("unexpected", { status: 500 });
    };
    const client = createGitHubAppClient({
      appSlug: "dhara-test",
      appId: "12345",
      clientId: "Iv1.test",
      clientSecret: "client-secret",
      privateKey: privateKeyPem,
      fetchImpl,
      nowMs: () => 1_000_000,
    });

    const installUrl = new URL(client.installationUrl("signed-state"));
    expect(installUrl.toString()).toContain("github.com/apps/dhara-test/installations/new");
    expect(installUrl.searchParams.get("state")).toBe("signed-state");

    await expect(client.exchangeUserCode("oauth-code")).resolves.toBe("user-secret-token");
    await expect(client.listUserInstallations("user-secret-token")).resolves.toEqual([123, 456]);
    await expect(client.mintInstallationToken(123)).resolves.toBe("installation-secret-token");
    await expect(client.listInstallationRepositories("installation-secret-token")).resolves.toEqual([
      { id: 77, name: "repo", fullName: "acme/repo", defaultBranch: "main", private: true },
    ]);

    const appAuth = calls.find((call) => call.url.endsWith("/app/installations/123/access_tokens"))?.headers.get("authorization");
    expect(appAuth).toMatch(/^Bearer /);
    const jwt = appAuth!.slice("Bearer ".length);
    expect(decodeJwtPart(jwt, 0)).toMatchObject({ alg: "RS256", typ: "JWT" });
    const claims = decodeJwtPart(jwt, 1);
    expect(claims.iss).toBe("12345");
    expect(Number(claims.exp) - Number(claims.iat)).toBeLessThanOrEqual(600);
    expect(calls.find((call) => call.url.endsWith("/user/installations?per_page=100"))?.headers.get("authorization")).toBe("Bearer user-secret-token");
    expect(calls.find((call) => call.url.endsWith("/installation/repositories?per_page=100"))?.headers.get("authorization")).toBe("Bearer installation-secret-token");
  });

  it("never includes provider response bodies or tokens in thrown errors", async () => {
    const client = createGitHubAppClient({
      appSlug: "dhara-test",
      appId: "12345",
      clientId: "Iv1.test",
      clientSecret: "client-secret",
      privateKey: privateKeyPem,
      fetchImpl: async () => new Response("provider-secret-detail", { status: 500 }),
      nowMs: () => 1_000_000,
    });
    await expect(client.exchangeUserCode("oauth-secret-code")).rejects.toThrow("github_provider_failed");
    try {
      await client.exchangeUserCode("oauth-secret-code");
    } catch (error) {
      const raw = String(error);
      expect(raw).not.toContain("provider-secret-detail");
      expect(raw).not.toContain("oauth-secret-code");
      expect(raw).not.toContain("client-secret");
    }
  });
});

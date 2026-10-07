import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createGitHubAppGateway } from "../src/github-app.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });

describe("GitHub App gateway", () => {
  it("uses OAuth user authorization to verify installation access and mints installation tokens server-side", async () => {
    const calls: Array<{ url: string; authorization: string | null; body: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input); const headers = new Headers(init?.headers); calls.push({ url, authorization: headers.get("authorization"), body: String(init?.body ?? "") });
      if (url.includes("login/oauth/access_token")) return new Response(JSON.stringify({ access_token: "user-secret" }), { status: 200, headers: { "content-type": "application/json" } });
      if (url.includes("/user/installations")) return new Response(JSON.stringify({ installations: [{ id: 44 }] }), { status: 200, headers: { "content-type": "application/json" } });
      if (url.includes("/app/installations/44/access_tokens")) return new Response(JSON.stringify({ token: "installation-secret" }), { status: 201, headers: { "content-type": "application/json" } });
      throw new Error(`unexpected URL ${url}`);
    };
    const gateway = createGitHubAppGateway({ appId: "123", appSlug: "dhara", clientId: "client", clientSecret: "client-secret", privateKey, callbackUrl: "https://api.example.com/auth/github/installation/callback", fetchImpl, nowMs: () => 1_800_000 });
    expect(gateway.installationUrl("signed-state")).toContain("state=signed-state");
    const userToken = await gateway.exchangeUserCode("code"); expect(userToken).toBe("user-secret");
    await expect(gateway.userCanAccessInstallation(userToken, 44)).resolves.toBe(true);
    await expect(gateway.mintInstallationToken(44)).resolves.toBe("installation-secret");
    expect(calls[0]?.body).toContain('"redirect_uri":"https://api.example.com/auth/github/installation/callback"');
    expect(calls.find((call) => call.url.includes("/user/installations"))?.authorization).toBe("Bearer user-secret");
    const appAuth = calls.find((call) => call.url.includes("/access_tokens"))?.authorization ?? ""; expect(appAuth).toMatch(/^Bearer [^.]+\.[^.]+\.[^.]+$/); expect(appAuth).not.toContain("user-secret");
  });
});

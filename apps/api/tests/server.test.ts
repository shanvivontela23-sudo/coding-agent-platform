import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { createApiServer } from "../src/server.js";

async function withServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = createApiServer({
    webOrigin: "http://localhost:3000",
    sessionSecret: "test-session-secret-that-is-long-enough",
    sessionDurationMs: 60_000,
    auth: {
      signInWithPassword: async () => ({ supabaseUserId: "11111111-1111-4111-8111-111111111111", email: "rep@example.com", provider: "email" }),
      startGitHubOAuth: () => ({ authorizationUrl: "https://project-ref.supabase.co/auth/v1/authorize?provider=github", flowId: "flow-1", flowCookie: "signed-flow-cookie" }),
      completeGitHubOAuth: async () => ({ supabaseUserId: "22222222-2222-4222-8222-222222222222", email: "dev@example.com", provider: "github" }),
    },
    resolveMembership: async () => ({ userId: "user-1", organizationId: "org-1" }),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind a TCP port");
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { server.close(); await once(server, "close"); }
}

describe("product API server", () => {
  it("starts and serves health", async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/health`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true, service: "api" });
    });
  });

  it("signs a rep in by email and sets the signed tenant session cookie", async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/auth/email`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email: "rep@example.com", password: "password" }), redirect: "manual" });
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("http://localhost:3000");
      expect(response.headers.get("set-cookie")).toContain("tenant_session=");
    });
  });

  it("starts optional GitHub login through Supabase", async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/auth/github/start`, { redirect: "manual" });
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toContain("project-ref.supabase.co/auth/v1/authorize");
      expect(response.headers.get("set-cookie")).toContain("supabase_oauth_flow=");
    });
  });
});

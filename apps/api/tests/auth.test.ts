import { describe, expect, it } from "vitest";
import { completeTenantLogin, createSessionToken, createSupabaseAuthClient, verifySessionToken } from "../src/auth.js";

const supabaseUrl = "https://project-ref.supabase.co";
const anonKey = "sb_publishable_test";
const flowSecret = "test-flow-secret-that-is-long-enough";

describe("Supabase Auth", () => {
  it("signs reps in with Supabase email/password and never sends credentials anywhere else", async () => {
    const calls: Array<{ url: string; headers: Headers; body: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers), body: String(init?.body ?? "") });
      return new Response(JSON.stringify({ access_token: "supabase-access-token", user: { id: "11111111-1111-4111-8111-111111111111", email: "rep@example.com" } }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const client = createSupabaseAuthClient({ supabaseUrl, anonKey, flowSecret, fetchImpl });
    await expect(client.signInWithPassword("rep@example.com", "correct horse battery staple")).resolves.toEqual({ supabaseUserId: "11111111-1111-4111-8111-111111111111", email: "rep@example.com", provider: "email" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${supabaseUrl}/auth/v1/token?grant_type=password`);
    expect(calls[0]?.headers.get("apikey")).toBe(anonKey);
  });

  it("preserves Supabase email_confirmed_at state for invitation matching", async () => {
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({
      access_token: "supabase-access-token",
      user: {
        id: "33333333-3333-4333-8333-333333333333",
        email: "invitee@example.com",
        email_confirmed_at: "2026-10-07T12:00:00Z",
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
    const client = createSupabaseAuthClient({ supabaseUrl, anonKey, flowSecret, fetchImpl });
    await expect(client.signInWithPassword("invitee@example.com", "password")).resolves.toEqual({
      supabaseUserId: "33333333-3333-4333-8333-333333333333",
      email: "invitee@example.com",
      emailConfirmed: true,
      provider: "email",
    });
  });

  it("does not treat confirmed_at alone as confirmed email", async () => {
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({
      access_token: "supabase-access-token",
      user: {
        id: "44444444-4444-4444-8444-444444444444",
        email: "oauth@example.com",
        confirmed_at: "2026-10-07T12:00:00Z",
        email_confirmed_at: null,
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
    const client = createSupabaseAuthClient({ supabaseUrl, anonKey, flowSecret, fetchImpl });
    await expect(client.signInWithPassword("oauth@example.com", "password")).resolves.toEqual({
      supabaseUserId: "44444444-4444-4444-8444-444444444444",
      email: "oauth@example.com",
      provider: "email",
    });
  });

  it("starts optional developer GitHub auth through Supabase with PKCE and exchanges only at Supabase", async () => {
    const tokenCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      tokenCalls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(JSON.stringify({ access_token: "github-through-supabase", user: { id: "22222222-2222-4222-8222-222222222222", email: "dev@example.com" } }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const client = createSupabaseAuthClient({ supabaseUrl, anonKey, flowSecret, fetchImpl, randomBytes: () => Buffer.alloc(48, 7), nowMs: () => 1_000 });
    const flow = client.startGitHubOAuth("http://localhost:3001/auth/github/callback");
    const authorize = new URL(flow.authorizationUrl);
    expect(authorize.origin).toBe(supabaseUrl);
    expect(authorize.pathname).toBe("/auth/v1/authorize");
    expect(authorize.searchParams.get("provider")).toBe("github");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("s256");
    await expect(client.completeGitHubOAuth({ code: "supabase-auth-code", flowId: flow.flowId, flowCookie: flow.flowCookie })).resolves.toMatchObject({ provider: "github" });
    expect(tokenCalls[0]?.url).toBe(`${supabaseUrl}/auth/v1/token?grant_type=pkce`);
    expect(typeof tokenCalls[0]?.body.code_verifier).toBe("string");
    expect(tokenCalls[0]?.url).not.toContain("github.com");
  });

  it("resolves local membership before issuing the signed tenant session", async () => {
    const secret = "test-session-secret-that-is-long-enough";
    const identity = { supabaseUserId: "11111111-1111-4111-8111-111111111111", email: "rep@example.com", provider: "email" as const };
    let resolvedId: string | null = null;
    const completed = await completeTenantLogin({ identity, sessionSecret: secret, nowMs: 1_000, sessionDurationMs: 60_000, resolveMembership: async (received) => { resolvedId = received.supabaseUserId; return { userId: "user-1", organizationId: "org-1" }; } });
    expect(resolvedId).toBe(identity.supabaseUserId);
    expect(verifySessionToken(completed.sessionToken, secret, 1_500)).toEqual({ userId: "user-1", organizationId: "org-1", expiresAtMs: 61_000 });
  });

  it("keeps signed tenant sessions tamper-evident", () => {
    const secret = "test-session-secret-that-is-long-enough";
    const token = createSessionToken({ userId: "user-1", organizationId: "org-1", expiresAtMs: 10_000 }, secret);
    expect(token).not.toContain(secret);
    expect(() => verifySessionToken(`${token}x`, secret, 9_000)).toThrow();
  });
});
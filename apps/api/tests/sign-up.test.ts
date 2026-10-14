import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { createSupabaseAuthClient, SignUpRejected, type SignUpResult, type SupabaseAuthClient } from "../src/auth.js";
import type { ProductDatabase } from "../src/database.js";
import { createApiServer, signUpFormError } from "../src/server.js";

const sessionSecret = "test-session-secret-that-is-long-enough";
const supabaseUserId = "60000000-0000-4000-8000-000000000001";

function supabase(response: { status: number; body: unknown }, calls: string[] = []) {
  return createSupabaseAuthClient({
    supabaseUrl: "https://project-ref.supabase.co",
    anonKey: "anon",
    flowSecret: "flow-secret-that-is-at-least-32-characters",
    fetchImpl: (async (url: string) => { calls.push(url); return new Response(JSON.stringify(response.body), { status: response.status }); }) as unknown as typeof fetch,
  });
}

describe("Supabase sign-up", () => {
  it("reports confirmation_required when Supabase returns a user without a session", async () => {
    const calls: string[] = [];
    const result = await supabase({ status: 200, body: { id: supabaseUserId, email: "new@example.com", confirmation_sent_at: "now" } }, calls).signUpWithPassword!("new@example.com", "password123", "https://demo.trycloudflare.com/");
    expect(result).toEqual({ status: "confirmation_required" });
    expect(calls[0]).toBe("https://project-ref.supabase.co/auth/v1/signup?redirect_to=https%3A%2F%2Fdemo.trycloudflare.com%2F");
  });

  it("signs in straight away when Supabase returns a session", async () => {
    const result = await supabase({ status: 200, body: { access_token: "t", user: { id: supabaseUserId, email: "new@example.com", email_confirmed_at: "now" } } }).signUpWithPassword!("new@example.com", "password123", "https://x/");
    expect(result).toEqual({ status: "signed_in", identity: { supabaseUserId, email: "new@example.com", provider: "email", emailConfirmed: true } });
  });

  it.each([
    [{ status: 422, body: { error_code: "weak_password" } }, "weak_password"],
    [{ status: 400, body: { error_code: "email_address_invalid" } }, "invalid_email"],
    [{ status: 429, body: { error_code: "over_email_send_rate_limit" } }, "rate_limited"],
    [{ status: 422, body: { error_code: "signup_disabled" } }, "disabled"],
    [{ status: 400, body: { error_code: "email_address_not_authorized" } }, "email_not_allowed"],
    [{ status: 500, body: {} }, "failed"],
  ] as const)("maps Supabase rejection %j to %s", async (response, reason) => {
    await expect(supabase(response).signUpWithPassword!("a@b.co", "password123", "https://x/")).rejects.toMatchObject({ reason });
  });
});

describe("sign-up form validation", () => {
  it.each([
    ["not-an-email", "password123", "password123", "Enter a valid email address."],
    ["a@b.co", "short", "short", "Use a password of 8 to 128 characters."],
    ["a@b.co", "password123", "password124", "The two passwords don't match."],
  ])("rejects %s / %s", (email, password, confirm, message) => {
    expect(signUpFormError(email, password, confirm)).toBe(message);
  });

  it("accepts a valid form", () => {
    expect(signUpFormError("friend@example.com", "password123", "password123")).toBeNull();
  });
});

function database(): ProductDatabase {
  return { lookupMemberships: async () => [], listVerifiedInvitations: async () => [] } as unknown as ProductDatabase;
}

async function postSignUp(signUp: SupabaseAuthClient["signUpWithPassword"], form: Record<string, string>) {
  const auth = {
    signInWithPassword: async () => { throw new Error("not used"); },
    startGitHubOAuth: () => { throw new Error("not used"); },
    completeGitHubOAuth: async () => { throw new Error("not used"); },
    ...(signUp ? { signUpWithPassword: signUp } : {}),
  } as SupabaseAuthClient;
  const server = createApiServer({ webOrigin: "https://demo.trycloudflare.com", apiOrigin: "https://demo.trycloudflare.com", sessionSecret, sessionDurationMs: 60_000, onboardingDurationMs: 60_000, auth, database: database() });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/auth/sign-up`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() });
    return { location: response.headers.get("location") ?? "", cookies: response.headers.get("set-cookie") ?? "" };
  } finally { server.close(); await once(server, "close"); }
}

describe("POST /auth/sign-up", () => {
  const valid = { email: "Friend@Example.com", password: "password123", confirmPassword: "password123" };

  it("asks the person to confirm their email, without saying whether the address already existed", async () => {
    const seen: string[] = [];
    const { location } = await postSignUp(async (email, _password, redirectTo) => { seen.push(email, redirectTo); return { status: "confirmation_required" } satisfies SignUpResult; }, valid);
    expect(seen).toEqual(["friend@example.com", "https://demo.trycloudflare.com"]);
    expect(location).toBe("https://demo.trycloudflare.com/?notice=Check+your+email+for+a+confirmation+link%2C+then+sign+in+here.");
  });

  it("signs a new person straight into onboarding when no confirmation is needed", async () => {
    const { location, cookies } = await postSignUp(async () => ({ status: "signed_in", identity: { supabaseUserId, email: "friend@example.com", provider: "email" } }), valid);
    expect(location).toBe("https://demo.trycloudflare.com/onboarding");
    expect(cookies).toContain("onboarding_session=");
    expect(cookies).toContain("Secure");
  });

  it("returns form problems to the sign-up page before calling Supabase", async () => {
    let called = false;
    const { location } = await postSignUp(async () => { called = true; return { status: "confirmation_required" }; }, { ...valid, confirmPassword: "different1" });
    expect(called).toBe(false);
    expect(new URL(location).pathname).toBe("/signup");
    expect(new URL(location).searchParams.get("error")).toBe("The two passwords don't match.");
  });

  it("shows a specific message when Supabase rejects the password", async () => {
    const { location } = await postSignUp(async () => { throw new SignUpRejected("weak_password"); }, valid);
    expect(new URL(location).searchParams.get("error")).toContain("stronger password");
  });

  it("says sign-up is unavailable when the auth client cannot sign people up", async () => {
    const { location } = await postSignUp(undefined, valid);
    expect(new URL(location).pathname).toBe("/signup");
    expect(new URL(location).searchParams.get("error")).toBe("Sign-up is not available.");
  });
});

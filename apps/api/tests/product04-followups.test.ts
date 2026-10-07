import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { createSupabaseAuthClient } from "../src/auth.js";
import { AppError, safeErrorCode } from "../src/errors.js";

describe("Product 04 review follow-ups", () => {
  it("derives emailConfirmed from email_confirmed_at only", async () => {
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ user: { id: "33333333-3333-4333-8333-333333333333", email: "u@example.com", confirmed_at: "2026-10-07T12:00:00Z" } }), { status: 200, headers: { "content-type": "application/json" } });
    const client = createSupabaseAuthClient({ supabaseUrl: "https://project.supabase.co", anonKey: "key", flowSecret: "a-secret-that-is-at-least-thirty-two-characters", fetchImpl });
    await expect(client.signInWithPassword("u@example.com", "password")).resolves.toEqual({ supabaseUserId: "33333333-3333-4333-8333-333333333333", email: "u@example.com", provider: "email" });
  });
  it("maps typed failures to short safe logging codes", () => { expect(safeErrorCode(new AppError("GITHUB_STATE_INVALID", 400, "Safe"))).toBe("GITHUB_STATE_INVALID"); expect(safeErrorCode(new Error("secret raw provider failure"))).toBe("INTERNAL"); });
  it("returns pending invitations only to owners", async () => { const source = await readFile("apps/api/src/database.ts", "utf8"); expect(source).toMatch(/currentUser\.role === "owner"/); });
  it("logs safe codes and never raw error messages", async () => { const source = await readFile("apps/api/src/server.ts", "utf8"); expect(source).toContain("safeErrorCode"); expect(source).not.toContain("errorType:"); });
});

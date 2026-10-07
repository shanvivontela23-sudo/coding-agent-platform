import { createHash, createHmac, randomBytes as nodeRandomBytes, timingSafeEqual } from "node:crypto";

export type SessionIdentity = { readonly userId: string; readonly organizationId: string; readonly expiresAtMs: number };
export type OnboardingIdentity = { readonly supabaseUserId: string; readonly email: string | null; readonly expiresAtMs: number };
export type SupabaseIdentity = { readonly supabaseUserId: string; readonly email: string | null; readonly provider: "email" | "github" };
export type GitHubOAuthFlow = { readonly authorizationUrl: string; readonly flowId: string; readonly flowCookie: string };
export type SupabaseAuthClient = {
  signInWithPassword(email: string, password: string): Promise<SupabaseIdentity>;
  startGitHubOAuth(callbackUrl: string): GitHubOAuthFlow;
  completeGitHubOAuth(input: { readonly code: string; readonly flowId: string; readonly flowCookie: string }): Promise<SupabaseIdentity>;
};

export type SupabaseAuthClientOptions = {
  readonly supabaseUrl: string;
  readonly anonKey: string;
  readonly flowSecret: string;
  readonly fetchImpl?: typeof fetch;
  readonly randomBytes?: () => Uint8Array;
  readonly nowMs?: () => number;
};

type OAuthFlowPayload = { readonly flowId: string; readonly codeVerifier: string; readonly expiresAtMs: number };
type OnboardingPayload = OnboardingIdentity & { readonly purpose: "onboarding" };

function b64(value: string | Uint8Array): string { return Buffer.from(value).toString("base64url"); }
function hmac(payload: string, secret: string): string {
  if (secret.length < 32) throw new Error("secret must be at least 32 characters");
  return createHmac("sha256", secret).update(payload).digest("base64url");
}
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function normalizeSupabaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") throw new Error("Supabase URL must use HTTPS outside loopback");
  return url.toString().replace(/\/$/, "");
}
async function readIdentity(response: Response, provider: SupabaseIdentity["provider"]): Promise<SupabaseIdentity> {
  if (!response.ok) throw new Error(`Supabase Auth failed with status ${response.status}`);
  const body = await response.json() as { user?: { id?: unknown; email?: unknown } };
  if (typeof body.user?.id !== "string" || !body.user.id) throw new Error("Supabase Auth response did not include a user id");
  return { supabaseUserId: body.user.id, email: typeof body.user.email === "string" ? body.user.email : null, provider };
}
function parseFlowCookie(cookie: string, secret: string, nowMs: number): OAuthFlowPayload {
  const [payload, signature, extra] = cookie.split(".");
  if (!payload || !signature || extra !== undefined || !safeEqual(signature, hmac(payload, secret))) throw new Error("invalid Supabase OAuth flow cookie");
  const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as OAuthFlowPayload;
  if (!parsed.flowId || !parsed.codeVerifier || parsed.expiresAtMs <= nowMs) throw new Error("expired or invalid Supabase OAuth flow");
  return parsed;
}

export function createSupabaseAuthClient(options: SupabaseAuthClientOptions): SupabaseAuthClient {
  const base = normalizeSupabaseUrl(options.supabaseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const random = options.randomBytes ?? (() => nodeRandomBytes(48));
  const now = options.nowMs ?? Date.now;
  const post = async (url: string, body: unknown) => await fetchImpl(url, {
    method: "POST",
    headers: { apikey: options.anonKey, authorization: `Bearer ${options.anonKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    signInWithPassword: async (email, password) => readIdentity(await post(`${base}/auth/v1/token?grant_type=password`, { email, password }), "email"),
    startGitHubOAuth: (callbackUrl) => {
      const codeVerifier = b64(random());
      const flowId = b64(random()).slice(0, 48);
      const payload: OAuthFlowPayload = { flowId, codeVerifier, expiresAtMs: now() + 10 * 60_000 };
      const encoded = b64(JSON.stringify(payload));
      const flowCookie = `${encoded}.${hmac(encoded, options.flowSecret)}`;
      const redirect = new URL(callbackUrl);
      redirect.searchParams.set("flow", flowId);
      const authorize = new URL(`${base}/auth/v1/authorize`);
      authorize.searchParams.set("provider", "github");
      authorize.searchParams.set("redirect_to", redirect.toString());
      authorize.searchParams.set("code_challenge", createHash("sha256").update(codeVerifier).digest("base64url"));
      authorize.searchParams.set("code_challenge_method", "s256");
      return { authorizationUrl: authorize.toString(), flowId, flowCookie };
    },
    completeGitHubOAuth: async ({ code, flowId, flowCookie }) => {
      const flow = parseFlowCookie(flowCookie, options.flowSecret, now());
      if (!safeEqual(flow.flowId, flowId)) throw new Error("Supabase OAuth flow id mismatch");
      return readIdentity(await post(`${base}/auth/v1/token?grant_type=pkce`, { auth_code: code, code_verifier: flow.codeVerifier }), "github");
    },
  };
}

function signedToken(payload: object, secret: string): string {
  const encoded = b64(JSON.stringify(payload));
  return `${encoded}.${hmac(encoded, secret)}`;
}
function verifiedPayload(token: string, secret: string): Record<string, unknown> {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined || !safeEqual(signature, hmac(payload, secret))) throw new Error("invalid signed token");
  const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("invalid signed token payload");
  return parsed as Record<string, unknown>;
}

export function createSessionToken(identity: SessionIdentity, secret: string): string {
  if (!identity.userId || !identity.organizationId) throw new Error("session identity is incomplete");
  return signedToken(identity, secret);
}
export function verifySessionToken(token: string, secret: string, nowMs = Date.now()): SessionIdentity {
  const parsed = verifiedPayload(token, secret);
  if (typeof parsed.userId !== "string" || !parsed.userId || typeof parsed.organizationId !== "string" || !parsed.organizationId || typeof parsed.expiresAtMs !== "number" || !Number.isFinite(parsed.expiresAtMs) || parsed.expiresAtMs <= nowMs) throw new Error("invalid or expired session");
  return { userId: parsed.userId, organizationId: parsed.organizationId, expiresAtMs: parsed.expiresAtMs };
}

export function createOnboardingToken(identity: OnboardingIdentity, secret: string): string {
  if (!identity.supabaseUserId) throw new Error("onboarding identity is incomplete");
  return signedToken({ ...identity, purpose: "onboarding" satisfies OnboardingPayload["purpose"] }, secret);
}
export function verifyOnboardingToken(token: string, secret: string, nowMs = Date.now()): OnboardingIdentity {
  const parsed = verifiedPayload(token, secret);
  if (parsed.purpose !== "onboarding" || typeof parsed.supabaseUserId !== "string" || !parsed.supabaseUserId || (parsed.email !== null && typeof parsed.email !== "string") || typeof parsed.expiresAtMs !== "number" || !Number.isFinite(parsed.expiresAtMs) || parsed.expiresAtMs <= nowMs) throw new Error("invalid or expired onboarding session");
  return { supabaseUserId: parsed.supabaseUserId, email: parsed.email as string | null, expiresAtMs: parsed.expiresAtMs };
}

export async function completeTenantLogin(options: {
  readonly identity: SupabaseIdentity;
  readonly sessionSecret: string;
  readonly sessionDurationMs: number;
  readonly nowMs?: number;
  readonly resolveMembership: (identity: SupabaseIdentity) => Promise<Pick<SessionIdentity, "userId" | "organizationId">>;
}): Promise<{ readonly session: SessionIdentity; readonly sessionToken: string }> {
  const membership = await options.resolveMembership(options.identity);
  const now = options.nowMs ?? Date.now();
  const session = { ...membership, expiresAtMs: now + options.sessionDurationMs };
  return { session, sessionToken: createSessionToken(session, options.sessionSecret) };
}

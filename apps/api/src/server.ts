import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  createOnboardingToken,
  createSessionToken,
  verifyOnboardingToken,
  verifySessionToken,
  type OnboardingIdentity,
  type SupabaseAuthClient,
  type SupabaseIdentity,
} from "./auth.js";
import type { InviteRole, Membership, ProductDatabase } from "./database.js";

export type ApiServerOptions = {
  readonly webOrigin: string;
  readonly apiOrigin?: string;
  readonly sessionSecret: string;
  readonly sessionDurationMs: number;
  readonly onboardingDurationMs: number;
  readonly auth: SupabaseAuthClient;
  readonly database: ProductDatabase;
};

function redirect(response: ServerResponse, location: string): void {
  response.statusCode = 303;
  response.setHeader("location", location);
  response.end();
}
function cookie(name: string, value: string, maxAgeSeconds: number, secure: boolean): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}
function clearCookie(name: string, secure: boolean): string {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}
function appendCookie(response: ServerResponse, value: string): void {
  const existing = response.getHeader("set-cookie");
  if (!existing) response.setHeader("set-cookie", value);
  else if (Array.isArray(existing)) response.setHeader("set-cookie", [...existing.map(String), value]);
  else response.setHeader("set-cookie", [String(existing), value]);
}
async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
function cookies(request: IncomingMessage): Map<string, string> {
  const values = new Map<string, string>();
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0) values.set(part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim()));
  }
  return values;
}
function webLocation(origin: string, path: string, error?: string): string {
  const url = new URL(path, origin);
  if (error) url.searchParams.set("error", error);
  return url.toString().replace(/\/$/, path === "/" ? "" : "/");
}
function sessionFromMembership(membership: Pick<Membership, "userId" | "organizationId">, durationMs: number) {
  return {
    userId: membership.userId,
    organizationId: membership.organizationId,
    expiresAtMs: Date.now() + durationMs,
  };
}
function logCaughtError(request: IncomingMessage, pathname: string, error: unknown): void {
  console.error(JSON.stringify({
    event: "api_error",
    method: request.method ?? "UNKNOWN",
    path: pathname,
    errorType: error instanceof Error ? error.name : "UnknownError",
  }));
}

export function createApiServer(options: ApiServerOptions) {
  const apiOrigin = options.apiOrigin ?? "http://localhost:3001";
  const secureCookies = new URL(apiOrigin).protocol === "https:";
  const finishIdentity = async (identity: SupabaseIdentity, response: ServerResponse): Promise<void> => {
    const memberships = await options.database.lookupMemberships(identity);
    if (memberships.length === 0) {
      const onboardingIdentity: OnboardingIdentity = {
        supabaseUserId: identity.supabaseUserId,
        email: identity.email,
        ...(identity.emailConfirmed !== undefined ? { emailConfirmed: identity.emailConfirmed } : {}),
        expiresAtMs: Date.now() + options.onboardingDurationMs,
      };
      const onboarding = createOnboardingToken(onboardingIdentity, options.sessionSecret);
      appendCookie(response, cookie("onboarding_session", onboarding, Math.floor(options.onboardingDurationMs / 1000), secureCookies));
      if (identity.emailConfirmed === true) {
        const invitations = await options.database.listVerifiedInvitations(onboardingIdentity);
        if (invitations.length > 0) {
          redirect(response, webLocation(options.webOrigin, "/invites"));
          return;
        }
      }
      redirect(response, webLocation(options.webOrigin, "/onboarding"));
      return;
    }
    if (memberships.length > 1) throw new Error("multiple memberships");
    const session = sessionFromMembership(memberships[0]!, options.sessionDurationMs);
    appendCookie(response, cookie("tenant_session", createSessionToken(session, options.sessionSecret), Math.floor(options.sessionDurationMs / 1000), secureCookies));
    redirect(response, webLocation(options.webOrigin, "/home"));
  };

  return createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", apiOrigin);
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ ok: true, service: "api" }));
        return;
      }
      if (request.method === "POST" && url.pathname === "/auth/email") {
        const form = new URLSearchParams(await body(request));
        const email = form.get("email") ?? "";
        const password = form.get("password") ?? "";
        const identity = await options.auth.signInWithPassword(email, password);
        await finishIdentity(identity, response);
        return;
      }
      if (request.method === "GET" && url.pathname === "/auth/github/start") {
        const flow = options.auth.startGitHubOAuth(`${apiOrigin}/auth/github/callback`);
        appendCookie(response, cookie("supabase_oauth_flow", flow.flowCookie, 600, secureCookies));
        redirect(response, flow.authorizationUrl);
        return;
      }
      if (request.method === "GET" && url.pathname === "/auth/github/callback") {
        const code = url.searchParams.get("code");
        const flowId = url.searchParams.get("flow");
        const flowCookie = cookies(request).get("supabase_oauth_flow");
        if (!code || !flowId || !flowCookie) throw new Error("missing OAuth callback state");
        const identity = await options.auth.completeGitHubOAuth({ code, flowId, flowCookie });
        appendCookie(response, clearCookie("supabase_oauth_flow", secureCookies));
        await finishIdentity(identity, response);
        return;
      }
      if (request.method === "POST" && url.pathname === "/onboarding/organization") {
        const onboardingCookie = cookies(request).get("onboarding_session");
        if (!onboardingCookie) throw new Error("missing onboarding session");
        const identity = verifyOnboardingToken(onboardingCookie, options.sessionSecret);
        const form = new URLSearchParams(await body(request));
        const organizationName = (form.get("organizationName") ?? "").trim();
        if (organizationName.length < 2 || organizationName.length > 80) throw new Error("invalid organization name");
        const created = await options.database.createOrganizationWithOwner(identity, organizationName);
        const session = { ...created, expiresAtMs: Date.now() + options.sessionDurationMs };
        appendCookie(response, cookie("tenant_session", createSessionToken(session, options.sessionSecret), Math.floor(options.sessionDurationMs / 1000), secureCookies));
        appendCookie(response, clearCookie("onboarding_session", secureCookies));
        redirect(response, webLocation(options.webOrigin, "/home"));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/invitations") {
        const onboardingCookie = cookies(request).get("onboarding_session");
        if (!onboardingCookie) throw new Error("missing onboarding session");
        const identity = verifyOnboardingToken(onboardingCookie, options.sessionSecret);
        const invitations = await options.database.listVerifiedInvitations(identity);
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ invitations }));
        return;
      }
      if (request.method === "POST" && url.pathname === "/invitations/accept") {
        const onboardingCookie = cookies(request).get("onboarding_session");
        if (!onboardingCookie) throw new Error("missing onboarding session");
        const identity = verifyOnboardingToken(onboardingCookie, options.sessionSecret);
        const form = new URLSearchParams(await body(request));
        const invitationId = form.get("invitationId") ?? "";
        const accepted = await options.database.acceptVerifiedInvitation(identity, invitationId);
        const session = { ...accepted, expiresAtMs: Date.now() + options.sessionDurationMs };
        appendCookie(response, cookie("tenant_session", createSessionToken(session, options.sessionSecret), Math.floor(options.sessionDurationMs / 1000), secureCookies));
        appendCookie(response, clearCookie("onboarding_session", secureCookies));
        redirect(response, webLocation(options.webOrigin, "/home"));
        return;
      }
      if (request.method === "POST" && url.pathname === "/invitations/decline") {
        const onboardingCookie = cookies(request).get("onboarding_session");
        if (!onboardingCookie) throw new Error("missing onboarding session");
        verifyOnboardingToken(onboardingCookie, options.sessionSecret);
        appendCookie(response, clearCookie("onboarding_session", secureCookies));
        redirect(response, options.webOrigin);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/home") {
        const token = cookies(request).get("tenant_session");
        if (!token) throw new Error("missing tenant session");
        const session = verifySessionToken(token, options.sessionSecret);
        const home = await options.database.getHome(session);
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(home));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/members") {
        const token = cookies(request).get("tenant_session");
        if (!token) throw new Error("missing tenant session");
        const session = verifySessionToken(token, options.sessionSecret);
        const members = await options.database.getMembers(session);
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(members));
        return;
      }
      if (request.method === "POST" && url.pathname === "/members/invitations") {
        const token = cookies(request).get("tenant_session");
        if (!token) throw new Error("missing tenant session");
        const session = verifySessionToken(token, options.sessionSecret);
        const form = new URLSearchParams(await body(request));
        const email = form.get("email") ?? "";
        const roleValue = form.get("role");
        if (roleValue !== "developer" && roleValue !== "rep") throw new Error("invalid invitation role");
        await options.database.createInvitation(session, email, roleValue satisfies InviteRole);
        redirect(response, webLocation(options.webOrigin, "/members"));
        return;
      }
      if (request.method === "POST" && url.pathname === "/auth/sign-out") {
        appendCookie(response, clearCookie("tenant_session", secureCookies));
        appendCookie(response, clearCookie("onboarding_session", secureCookies));
        redirect(response, options.webOrigin);
        return;
      }
      response.statusCode = 404;
      response.end("not found");
    } catch (error) {
      logCaughtError(request, url.pathname, error);
      if (request.method === "POST" && url.pathname === "/auth/email") {
        redirect(response, webLocation(options.webOrigin, "/", "Sign-in failed. Check your email and password."));
        return;
      }
      if (url.pathname.startsWith("/auth/github")) {
        redirect(response, webLocation(options.webOrigin, "/", "GitHub sign-in failed. Please try again."));
        return;
      }
      if (request.method === "POST" && url.pathname === "/onboarding/organization") {
        redirect(response, webLocation(options.webOrigin, "/onboarding", "Organization name must be 2 to 80 characters, or this account is already configured."));
        return;
      }
      if (request.method === "POST" && url.pathname === "/members/invitations") {
        redirect(response, webLocation(options.webOrigin, "/members", "Unable to send that invitation."));
        return;
      }
      if (url.pathname.startsWith("/invitations/")) {
        redirect(response, webLocation(options.webOrigin, "/invites", "That invitation could not be used."));
        return;
      }
      response.statusCode = 401;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ error: "Authentication required." }));
    }
  });
}

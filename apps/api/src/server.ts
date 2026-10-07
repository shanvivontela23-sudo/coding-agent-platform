import { createHash, createHmac, randomBytes as nodeRandomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  createOnboardingToken,
  createSessionToken,
  verifyOnboardingToken,
  verifySessionToken,
  type OnboardingIdentity,
  type SessionIdentity,
  type SupabaseAuthClient,
  type SupabaseIdentity,
} from "./auth.js";
import type { InviteRole, Membership, ProductDatabase } from "./database.js";
import { AppError, isSafeErrorCode, safeErrorCode, type SafeErrorCode } from "./errors.js";
import type { GitHubAppClient } from "./github-app.js";

export type ApiServerOptions = {
  readonly webOrigin: string;
  readonly apiOrigin?: string;
  readonly sessionSecret: string;
  readonly sessionDurationMs: number;
  readonly onboardingDurationMs: number;
  readonly auth: SupabaseAuthClient;
  readonly database: ProductDatabase;
  readonly githubApp?: GitHubAppClient;
  readonly nowMs?: () => number;
  readonly randomBytes?: () => Uint8Array;
};

const analysisLimits = {
  maxCompressedBytes: 50 * 1024 * 1024,
  maxUncompressedBytes: 250 * 1024 * 1024,
  maxFiles: 25_000,
  maxFileBytes: 2 * 1024 * 1024,
} as const;

type GitHubStatePayload = {
  readonly purpose: "github_install";
  readonly organizationId: string;
  readonly userId: string;
  readonly nonce: string;
  readonly expiresAtMs: number;
};

function redirect(response: ServerResponse, location: string): void { response.statusCode = 303; response.setHeader("location", location); response.end(); }
function cookie(name: string, value: string, maxAgeSeconds: number, secure: boolean): string { return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`; }
function clearCookie(name: string, secure: boolean): string { return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`; }
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
  return { userId: membership.userId, organizationId: membership.organizationId, expiresAtMs: Date.now() + durationMs };
}
function fallbackCode(pathname: string): SafeErrorCode {
  if (pathname === "/auth/email") return "AUTH_SIGN_IN_FAILED";
  if (pathname.includes("github")) return "GITHUB_FORBIDDEN";
  return "INTERNAL_ERROR";
}
function logCaughtError(request: IncomingMessage, pathname: string, error: unknown): void {
  console.error(JSON.stringify({ event: "api_error", method: request.method ?? "UNKNOWN", path: pathname, code: safeErrorCode(error, fallbackCode(pathname)) }));
}
function tenantSession(request: IncomingMessage, secret: string): SessionIdentity {
  const token = cookies(request).get("tenant_session");
  if (!token) throw new AppError("AUTH_REQUIRED", "Authentication required.", 401);
  try { return verifySessionToken(token, secret); }
  catch { throw new AppError("AUTH_REQUIRED", "Authentication required.", 401); }
}
function github(options: ApiServerOptions): GitHubAppClient {
  if (!options.githubApp) throw new AppError("GITHUB_FORBIDDEN", "GitHub connection is not configured.", 503);
  return options.githubApp;
}
function requireDatabaseMethod<K extends keyof ProductDatabase>(database: ProductDatabase, key: K): NonNullable<ProductDatabase[K]> {
  const method = database[key];
  if (typeof method !== "function") throw new AppError("INTERNAL_ERROR", "This feature is not configured.", 500);
  return method as NonNullable<ProductDatabase[K]>;
}
function hashNonce(nonce: string): string { return createHash("sha256").update(nonce).digest("hex"); }
function stateSignature(encoded: string, secret: string): string {
  if (secret.length < 32) throw new Error("secret must be at least 32 characters");
  return createHmac("sha256", secret).update(`github-install:${encoded}`).digest("base64url");
}
function createGitHubState(payload: GitHubStatePayload, secret: string): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${stateSignature(encoded, secret)}`;
}
function verifyGitHubState(value: string, secret: string, session: SessionIdentity, nowMs: number): GitHubStatePayload {
  const [encoded, signature, extra] = value.split(".");
  if (!encoded || !signature || extra !== undefined) throw new AppError("GITHUB_STATE_INVALID", "GitHub connection state is invalid or expired.", 400);
  const expected = stateSignature(encoded, secret);
  const left = Buffer.from(signature); const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) throw new AppError("GITHUB_STATE_INVALID", "GitHub connection state is invalid or expired.", 400);
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); }
  catch { throw new AppError("GITHUB_STATE_INVALID", "GitHub connection state is invalid or expired.", 400); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new AppError("GITHUB_STATE_INVALID", "GitHub connection state is invalid or expired.", 400);
  const state = parsed as Partial<GitHubStatePayload>;
  if (state.purpose !== "github_install" || state.organizationId !== session.organizationId || state.userId !== session.userId || typeof state.nonce !== "string" || state.nonce.length < 16 || typeof state.expiresAtMs !== "number" || state.expiresAtMs <= nowMs) throw new AppError("GITHUB_STATE_INVALID", "GitHub connection state is invalid or expired.", 400);
  return state as GitHubStatePayload;
}
function json(response: ServerResponse, status: number, value: unknown): void { response.statusCode = status; response.setHeader("content-type", "application/json"); response.end(JSON.stringify(value)); }

export function createApiServer(options: ApiServerOptions) {
  const apiOrigin = options.apiOrigin ?? "http://localhost:3001";
  const secureCookies = new URL(apiOrigin).protocol === "https:";
  const now = options.nowMs ?? Date.now;
  const random = options.randomBytes ?? (() => nodeRandomBytes(32));
  const finishIdentity = async (identity: SupabaseIdentity, response: ServerResponse): Promise<void> => {
    const memberships = await options.database.lookupMemberships(identity);
    if (memberships.length === 0) {
      const onboardingIdentity: OnboardingIdentity = { supabaseUserId: identity.supabaseUserId, email: identity.email, ...(identity.emailConfirmed !== undefined ? { emailConfirmed: identity.emailConfirmed } : {}), expiresAtMs: Date.now() + options.onboardingDurationMs };
      const onboarding = createOnboardingToken(onboardingIdentity, options.sessionSecret);
      appendCookie(response, cookie("onboarding_session", onboarding, Math.floor(options.onboardingDurationMs / 1000), secureCookies));
      if (identity.emailConfirmed === true && identity.email) {
        const invitations = await options.database.listVerifiedInvitations(onboardingIdentity);
        if (invitations.length > 0) { redirect(response, webLocation(options.webOrigin, "/invites")); return; }
      }
      redirect(response, webLocation(options.webOrigin, "/onboarding")); return;
    }
    if (memberships.length > 1) throw new Error("multiple memberships");
    const session = sessionFromMembership(memberships[0]!, options.sessionDurationMs);
    appendCookie(response, cookie("tenant_session", createSessionToken(session, options.sessionSecret), Math.floor(options.sessionDurationMs / 1000), secureCookies));
    redirect(response, webLocation(options.webOrigin, "/home"));
  };

  return createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", apiOrigin);
    try {
      if (request.method === "GET" && url.pathname === "/health") { json(response, 200, { ok: true, service: "api" }); return; }
      if (request.method === "POST" && url.pathname === "/auth/email") {
        const form = new URLSearchParams(await body(request));
        const identity = await options.auth.signInWithPassword(form.get("email") ?? "", form.get("password") ?? "");
        await finishIdentity(identity, response); return;
      }
      if (request.method === "GET" && url.pathname === "/auth/github/start") {
        const flow = options.auth.startGitHubOAuth(`${apiOrigin}/auth/github/callback`);
        appendCookie(response, cookie("supabase_oauth_flow", flow.flowCookie, 600, secureCookies)); redirect(response, flow.authorizationUrl); return;
      }
      if (request.method === "GET" && url.pathname === "/auth/github/callback") {
        const code = url.searchParams.get("code"); const flowId = url.searchParams.get("flow"); const flowCookie = cookies(request).get("supabase_oauth_flow");
        if (!code || !flowId || !flowCookie) throw new Error("missing OAuth callback state");
        const identity = await options.auth.completeGitHubOAuth({ code, flowId, flowCookie });
        appendCookie(response, clearCookie("supabase_oauth_flow", secureCookies)); await finishIdentity(identity, response); return;
      }
      if (request.method === "POST" && url.pathname === "/onboarding/organization") {
        const onboardingCookie = cookies(request).get("onboarding_session"); if (!onboardingCookie) throw new Error("missing onboarding session");
        const identity = verifyOnboardingToken(onboardingCookie, options.sessionSecret); const form = new URLSearchParams(await body(request)); const organizationName = (form.get("organizationName") ?? "").trim();
        if (organizationName.length < 2 || organizationName.length > 80) throw new Error("invalid organization name");
        const created = await options.database.createOrganizationWithOwner(identity, organizationName); const session = { ...created, expiresAtMs: Date.now() + options.sessionDurationMs };
        appendCookie(response, cookie("tenant_session", createSessionToken(session, options.sessionSecret), Math.floor(options.sessionDurationMs / 1000), secureCookies)); appendCookie(response, clearCookie("onboarding_session", secureCookies)); redirect(response, webLocation(options.webOrigin, "/home")); return;
      }
      if (request.method === "GET" && url.pathname === "/api/invitations") {
        const onboardingCookie = cookies(request).get("onboarding_session"); if (!onboardingCookie) throw new Error("missing onboarding session");
        const invitations = await options.database.listVerifiedInvitations(verifyOnboardingToken(onboardingCookie, options.sessionSecret)); json(response, 200, { invitations }); return;
      }
      if (request.method === "POST" && url.pathname === "/invitations/accept") {
        const onboardingCookie = cookies(request).get("onboarding_session"); if (!onboardingCookie) throw new Error("missing onboarding session");
        const identity = verifyOnboardingToken(onboardingCookie, options.sessionSecret); const form = new URLSearchParams(await body(request)); const accepted = await options.database.acceptVerifiedInvitation(identity, form.get("invitationId") ?? "");
        const session = { ...accepted, expiresAtMs: Date.now() + options.sessionDurationMs }; appendCookie(response, cookie("tenant_session", createSessionToken(session, options.sessionSecret), Math.floor(options.sessionDurationMs / 1000), secureCookies)); appendCookie(response, clearCookie("onboarding_session", secureCookies)); redirect(response, webLocation(options.webOrigin, "/home")); return;
      }
      if (request.method === "POST" && url.pathname === "/invitations/decline") {
        const onboardingCookie = cookies(request).get("onboarding_session"); if (!onboardingCookie) throw new Error("missing onboarding session"); verifyOnboardingToken(onboardingCookie, options.sessionSecret); appendCookie(response, clearCookie("onboarding_session", secureCookies)); redirect(response, options.webOrigin); return;
      }
      if (request.method === "GET" && url.pathname === "/api/home") { const session = tenantSession(request, options.sessionSecret); json(response, 200, await options.database.getHome(session)); return; }
      if (request.method === "GET" && url.pathname === "/api/members") {
        const session = tenantSession(request, options.sessionSecret); const members = await options.database.getMembers(session);
        json(response, 200, members.currentUser.role === "owner" ? members : { ...members, invitations: [] }); return;
      }
      if (request.method === "POST" && url.pathname === "/members/invitations") {
        const session = tenantSession(request, options.sessionSecret); const form = new URLSearchParams(await body(request)); const email = (form.get("email") ?? "").trim().toLowerCase(); const roleValue = form.get("role");
        if (roleValue !== "developer" && roleValue !== "rep") throw new Error("invalid invitation role"); await options.database.createInvitation(session, email, roleValue satisfies InviteRole); redirect(response, webLocation(options.webOrigin, "/members")); return;
      }
      if (request.method === "GET" && url.pathname === "/github/connect/start") {
        const session = tenantSession(request, options.sessionSecret); const role = await requireDatabaseMethod(options.database, "getMembershipRole")(session);
        if (role !== "owner" && role !== "developer") { redirect(response, webLocation(options.webOrigin, "/home", "Only owners and developers can connect repositories.")); return; }
        const nonce = Buffer.from(random()).toString("base64url"); const expiresAtMs = now() + 10 * 60_000;
        await requireDatabaseMethod(options.database, "createGitHubConnectionState")(session, hashNonce(nonce), new Date(expiresAtMs));
        const state = createGitHubState({ purpose: "github_install", organizationId: session.organizationId, userId: session.userId, nonce, expiresAtMs }, options.sessionSecret);
        redirect(response, github(options).installationUrl(state)); return;
      }
      if (request.method === "GET" && url.pathname === "/auth/github/installation/callback") {
        const session = tenantSession(request, options.sessionSecret); const stateValue = url.searchParams.get("state");
        if (!stateValue) throw new AppError("GITHUB_STATE_INVALID", "GitHub connection state is invalid or expired.", 400);
        const state = verifyGitHubState(stateValue, options.sessionSecret, session, now());
        const consumed = await requireDatabaseMethod(options.database, "consumeGitHubConnectionState")(session, hashNonce(state.nonce), new Date(now()));
        if (!consumed) throw new AppError("GITHUB_STATE_INVALID", "GitHub connection state is invalid or expired.", 400);
        if (url.searchParams.get("setup_action") === "request") { redirect(response, webLocation(options.webOrigin, "/github/repositories") + "?status=pending"); return; }
        const code = url.searchParams.get("code"); const installationId = Number(url.searchParams.get("installation_id"));
        if (!code || !Number.isSafeInteger(installationId) || installationId <= 0) throw new AppError("GITHUB_INSTALLATION_FORBIDDEN", "GitHub installation could not be verified.", 403);
        await github(options).verifyUserInstallation(code, installationId); await requireDatabaseMethod(options.database, "bindGitHubInstallation")(session, installationId);
        redirect(response, webLocation(options.webOrigin, "/github/repositories")); return;
      }
      if (request.method === "GET" && url.pathname === "/api/github/repositories") {
        const session = tenantSession(request, options.sessionSecret); const role = await requireDatabaseMethod(options.database, "getMembershipRole")(session);
        if (role !== "owner" && role !== "developer") throw new AppError("GITHUB_FORBIDDEN", "Repository access is not allowed for this role.", 403);
        const installation = await requireDatabaseMethod(options.database, "getGitHubInstallation")(session);
        if (!installation || installation.status !== "connected") throw new AppError("GITHUB_NOT_CONNECTED", "GitHub is not connected.", 409);
        try { json(response, 200, { repositories: await github(options).listRepositories(installation.installationId) }); }
        catch (error) { if (isSafeErrorCode(error, "GITHUB_INSTALLATION_DISCONNECTED")) await requireDatabaseMethod(options.database, "markGitHubInstallationDisconnected")(session); throw error; }
        return;
      }
      if (request.method === "POST" && url.pathname === "/github/projects") {
        const session = tenantSession(request, options.sessionSecret); const role = await requireDatabaseMethod(options.database, "getMembershipRole")(session);
        if (role !== "owner" && role !== "developer") throw new AppError("GITHUB_FORBIDDEN", "Repository access is not allowed for this role.", 403);
        const installation = await requireDatabaseMethod(options.database, "getGitHubInstallation")(session);
        if (!installation || installation.status !== "connected") throw new AppError("GITHUB_NOT_CONNECTED", "GitHub is not connected.", 409);
        const form = new URLSearchParams(await body(request)); const repositoryId = Number(form.get("repositoryId"));
        try {
          const analysed = await github(options).analyseRepository(installation.installationId, repositoryId, analysisLimits);
          const created = await requireDatabaseMethod(options.database, "createGitHubProject")(session, { repositoryId: analysed.repository.id, name: analysed.repository.name, fullName: analysed.repository.fullName, defaultBranch: analysed.repository.defaultBranch, commitSha: analysed.commitSha, report: analysed.report });
          redirect(response, webLocation(options.webOrigin, `/projects/${created.projectId}`));
        } catch (error) {
          if (isSafeErrorCode(error, "GITHUB_INSTALLATION_DISCONNECTED")) await requireDatabaseMethod(options.database, "markGitHubInstallationDisconnected")(session);
          throw error;
        }
        return;
      }
      if (request.method === "GET" && /^\/api\/projects\/[0-9a-f-]+$/i.test(url.pathname)) {
        const session = tenantSession(request, options.sessionSecret); const projectId = url.pathname.slice("/api/projects/".length); const project = await requireDatabaseMethod(options.database, "getProjectReport")(session, projectId);
        if (!project) throw new AppError("PROJECT_NOT_FOUND", "Project was not found.", 404);
        if (project.installation.status === "connected") {
          try { await github(options).checkInstallation(project.installation.installationId); }
          catch (error) {
            if (isSafeErrorCode(error, "GITHUB_INSTALLATION_DISCONNECTED")) {
              await requireDatabaseMethod(options.database, "markGitHubInstallationDisconnected")(session);
              json(response, 200, { ...project, installation: { ...project.installation, status: "disconnected" } }); return;
            }
            throw error;
          }
        }
        json(response, 200, project); return;
      }
      if (request.method === "POST" && url.pathname === "/auth/sign-out") { appendCookie(response, clearCookie("tenant_session", secureCookies)); appendCookie(response, clearCookie("onboarding_session", secureCookies)); redirect(response, options.webOrigin); return; }
      response.statusCode = 404; response.end("not found");
    } catch (error) {
      logCaughtError(request, url.pathname, error);
      if (request.method === "POST" && url.pathname === "/auth/email") { redirect(response, webLocation(options.webOrigin, "/", "Sign-in failed. Check your email and password.")); return; }
      if (url.pathname === "/auth/github/installation/callback" || url.pathname === "/github/connect/start") { redirect(response, webLocation(options.webOrigin, "/home", "Unable to connect that GitHub installation.")); return; }
      if (url.pathname === "/auth/github/start" || url.pathname === "/auth/github/callback") { redirect(response, webLocation(options.webOrigin, "/", "GitHub sign-in failed. Please try again.")); return; }
      if (request.method === "POST" && url.pathname === "/onboarding/organization") { redirect(response, webLocation(options.webOrigin, "/onboarding", "Organization name must be 2 to 80 characters, or this account is already configured.")); return; }
      if (request.method === "POST" && url.pathname === "/members/invitations") { redirect(response, webLocation(options.webOrigin, "/members", "Unable to send that invitation.")); return; }
      if (url.pathname.startsWith("/invitations/")) { redirect(response, webLocation(options.webOrigin, "/invites", "That invitation could not be used.")); return; }
      if (request.method === "POST" && url.pathname === "/github/projects") {
        const message = isSafeErrorCode(error, "REPOSITORY_TOO_LARGE") ? "Repository too large to analyse." : isSafeErrorCode(error, "GITHUB_INSTALLATION_DISCONNECTED") ? "GitHub was disconnected. Reconnect to continue." : "Unable to analyse that repository.";
        redirect(response, webLocation(options.webOrigin, "/github/repositories", message)); return;
      }
      if (url.pathname.startsWith("/api/")) {
        const status = error instanceof AppError ? error.status : isSafeErrorCode(error, "GITHUB_INSTALLATION_DISCONNECTED") ? 409 : 401;
        const code = safeErrorCode(error, status === 401 ? "AUTH_REQUIRED" : "INTERNAL_ERROR");
        json(response, status, { code, error: error instanceof AppError ? error.publicMessage : status === 401 ? "Authentication required." : "Request failed." }); return;
      }
      response.statusCode = 401; json(response, 401, { code: "AUTH_REQUIRED", error: "Authentication required." });
    }
  });
}

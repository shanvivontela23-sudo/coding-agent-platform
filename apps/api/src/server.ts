import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { analyzeProject } from "../../../packages/project-analysis/index.js";
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
import type { GitHubDatabase, InviteRole, Membership, ProductDatabase } from "./database.js";
import { ApiError, safeErrorCode } from "./errors.js";
import {
  createInstallStateToken,
  selectVerifiedInstallation,
  verifyInstallStateToken,
  type GitHubAppClient,
} from "./github-app.js";

export type ApiServerOptions = {
  readonly webOrigin: string;
  readonly apiOrigin?: string;
  readonly sessionSecret: string;
  readonly sessionDurationMs: number;
  readonly onboardingDurationMs: number;
  readonly auth: SupabaseAuthClient;
  readonly database: ProductDatabase & Partial<GitHubDatabase>;
  readonly github?: GitHubAppClient;
  readonly githubStateSecret?: string;
  readonly githubStateDurationMs?: number;
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
    code: safeErrorCode(error),
  }));
}
function tenantSession(request: IncomingMessage, secret: string): SessionIdentity {
  const token = cookies(request).get("tenant_session");
  if (!token) throw new ApiError("auth_required", 401);
  try { return verifySessionToken(token, secret); }
  catch { throw new ApiError("auth_required", 401); }
}
function onboardingIdentity(request: IncomingMessage, secret: string): OnboardingIdentity {
  const token = cookies(request).get("onboarding_session");
  if (!token) throw new ApiError("auth_required", 401);
  try { return verifyOnboardingToken(token, secret); }
  catch { throw new ApiError("auth_required", 401); }
}
function githubDatabase(database: ProductDatabase & Partial<GitHubDatabase>): GitHubDatabase {
  const required: Array<keyof GitHubDatabase> = [
    "getCurrentMemberRole",
    "createGitHubInstallState",
    "consumeGitHubInstallState",
    "bindGitHubInstallation",
    "getGitHubInstallation",
    "createProjectFromRepository",
    "getProject",
  ];
  for (const key of required) if (typeof database[key] !== "function") throw new ApiError("internal_error", 500);
  return database as ProductDatabase & GitHubDatabase;
}
function githubDependencies(options: ApiServerOptions): { readonly client: GitHubAppClient; readonly database: GitHubDatabase; readonly stateSecret: string; readonly stateDurationMs: number } {
  if (!options.github || !options.githubStateSecret || options.githubStateSecret.length < 32) throw new ApiError("internal_error", 500);
  const stateDurationMs = options.githubStateDurationMs ?? 10 * 60_000;
  if (!Number.isFinite(stateDurationMs) || stateDurationMs <= 0 || stateDurationMs > 30 * 60_000) throw new ApiError("internal_error", 500);
  return { client: options.github, database: githubDatabase(options.database), stateSecret: options.githubStateSecret, stateDurationMs };
}
async function requireConnectorRole(database: GitHubDatabase, session: SessionIdentity): Promise<void> {
  const role = await database.getCurrentMemberRole(session);
  if (role !== "owner" && role !== "developer") throw new ApiError("forbidden", 403);
}
function callbackInstallationId(value: string | null): number | null {
  if (value === null) return null;
  if (!/^[1-9][0-9]*$/.test(value)) throw new ApiError("github_installation_unverified", 400);
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new ApiError("github_installation_unverified", 400);
  return id;
}

export function createApiServer(options: ApiServerOptions) {
  const apiOrigin = options.apiOrigin ?? "http://localhost:3001";
  const secureCookies = new URL(apiOrigin).protocol === "https:";
  const finishIdentity = async (identity: SupabaseIdentity, response: ServerResponse): Promise<void> => {
    const memberships = await options.database.lookupMemberships(identity);
    if (memberships.length === 0) {
      const onboardingIdentityValue: OnboardingIdentity = {
        supabaseUserId: identity.supabaseUserId,
        email: identity.email,
        ...(identity.emailConfirmed !== undefined ? { emailConfirmed: identity.emailConfirmed } : {}),
        expiresAtMs: Date.now() + options.onboardingDurationMs,
      };
      const onboarding = createOnboardingToken(onboardingIdentityValue, options.sessionSecret);
      appendCookie(response, cookie("onboarding_session", onboarding, Math.floor(options.onboardingDurationMs / 1000), secureCookies));
      if (identity.emailConfirmed === true && identity.email) {
        const invitations = await options.database.listVerifiedInvitations(onboardingIdentityValue);
        if (invitations.length > 0) {
          redirect(response, webLocation(options.webOrigin, "/invites"));
          return;
        }
      }
      redirect(response, webLocation(options.webOrigin, "/onboarding"));
      return;
    }
    if (memberships.length > 1) throw new ApiError("conflict", 409);
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
        let identity: SupabaseIdentity;
        try { identity = await options.auth.signInWithPassword(email, password); }
        catch { throw new ApiError("auth_failed", 401); }
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
        if (!code || !flowId || !flowCookie) throw new ApiError("auth_failed", 401);
        let identity: SupabaseIdentity;
        try { identity = await options.auth.completeGitHubOAuth({ code, flowId, flowCookie }); }
        catch { throw new ApiError("auth_failed", 401); }
        appendCookie(response, clearCookie("supabase_oauth_flow", secureCookies));
        await finishIdentity(identity, response);
        return;
      }

      if (request.method === "GET" && url.pathname === "/github/install/start") {
        const session = tenantSession(request, options.sessionSecret);
        const github = githubDependencies(options);
        await requireConnectorRole(github.database, session);
        const stateRecord = await github.database.createGitHubInstallState(session, Date.now() + github.stateDurationMs);
        const state = createInstallStateToken({ stateId: stateRecord.id, expiresAtMs: stateRecord.expiresAtMs }, github.stateSecret);
        redirect(response, github.client.installationUrl(state));
        return;
      }
      if (request.method === "GET" && url.pathname === "/github/callback") {
        const session = tenantSession(request, options.sessionSecret);
        const github = githubDependencies(options);
        const stateValue = url.searchParams.get("state");
        const code = url.searchParams.get("code");
        if (!stateValue || !code) throw new ApiError("github_state_invalid", 400);
        const state = verifyInstallStateToken(stateValue, github.stateSecret);
        await github.database.consumeGitHubInstallState(session, state.stateId);
        await requireConnectorRole(github.database, session);
        const userToken = await github.client.exchangeUserCode(code);
        const accessibleInstallations = await github.client.listUserInstallations(userToken);
        const installationId = selectVerifiedInstallation(callbackInstallationId(url.searchParams.get("installation_id")), accessibleInstallations, new Set());
        await github.database.bindGitHubInstallation(session, installationId);
        redirect(response, webLocation(options.webOrigin, "/connect/github"));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/github/repositories") {
        const session = tenantSession(request, options.sessionSecret);
        const github = githubDependencies(options);
        await requireConnectorRole(github.database, session);
        const installationId = await github.database.getGitHubInstallation(session);
        if (installationId === null) throw new ApiError("not_found", 404);
        const installationToken = await github.client.mintInstallationToken(installationId);
        const repositories = await github.client.listInstallationRepositories(installationToken);
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ repositories }));
        return;
      }
      if (request.method === "POST" && url.pathname === "/projects") {
        const session = tenantSession(request, options.sessionSecret);
        const github = githubDependencies(options);
        await requireConnectorRole(github.database, session);
        const form = new URLSearchParams(await body(request));
        const rawRepositoryId = form.get("repositoryId") ?? "";
        if (!/^[1-9][0-9]*$/.test(rawRepositoryId)) throw new ApiError("invalid_request", 400);
        const repositoryId = Number(rawRepositoryId);
        if (!Number.isSafeInteger(repositoryId)) throw new ApiError("invalid_request", 400);
        const installationId = await github.database.getGitHubInstallation(session);
        if (installationId === null) throw new ApiError("not_found", 404);
        const installationToken = await github.client.mintInstallationToken(installationId);
        const source = await github.client.loadRepositorySnapshot(installationToken, repositoryId);
        const report = analyzeProject(source.snapshot);
        const created = await github.database.createProjectFromRepository(session, {
          repositoryId: source.repository.id,
          repositoryName: source.repository.name,
          fullName: source.repository.fullName,
          defaultBranch: source.repository.defaultBranch,
          commitSha: source.commitSha,
          report,
        });
        redirect(response, webLocation(options.webOrigin, `/projects/${created.projectId}`));
        return;
      }
      const projectMatch = request.method === "GET" ? /^\/api\/projects\/([0-9a-f-]+)$/i.exec(url.pathname) : null;
      if (projectMatch?.[1]) {
        const session = tenantSession(request, options.sessionSecret);
        const database = githubDatabase(options.database);
        const project = await database.getProject(session, projectMatch[1]);
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(project));
        return;
      }

      if (request.method === "POST" && url.pathname === "/onboarding/organization") {
        const identity = onboardingIdentity(request, options.sessionSecret);
        const form = new URLSearchParams(await body(request));
        const organizationName = (form.get("organizationName") ?? "").trim();
        if (organizationName.length < 2 || organizationName.length > 80) throw new ApiError("invalid_request", 400);
        const created = await options.database.createOrganizationWithOwner(identity, organizationName);
        const session = { ...created, expiresAtMs: Date.now() + options.sessionDurationMs };
        appendCookie(response, cookie("tenant_session", createSessionToken(session, options.sessionSecret), Math.floor(options.sessionDurationMs / 1000), secureCookies));
        appendCookie(response, clearCookie("onboarding_session", secureCookies));
        redirect(response, webLocation(options.webOrigin, "/home"));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/invitations") {
        const identity = onboardingIdentity(request, options.sessionSecret);
        const invitations = await options.database.listVerifiedInvitations(identity);
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ invitations }));
        return;
      }
      if (request.method === "POST" && url.pathname === "/invitations/accept") {
        const identity = onboardingIdentity(request, options.sessionSecret);
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
        onboardingIdentity(request, options.sessionSecret);
        appendCookie(response, clearCookie("onboarding_session", secureCookies));
        redirect(response, options.webOrigin);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/home") {
        const session = tenantSession(request, options.sessionSecret);
        const home = await options.database.getHome(session);
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(home));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/members") {
        const session = tenantSession(request, options.sessionSecret);
        const members = await options.database.getMembers(session);
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(members));
        return;
      }
      if (request.method === "POST" && url.pathname === "/members/invitations") {
        const session = tenantSession(request, options.sessionSecret);
        const form = new URLSearchParams(await body(request));
        const email = (form.get("email") ?? "").trim().toLowerCase();
        const roleValue = form.get("role");
        if (roleValue !== "developer" && roleValue !== "rep") throw new ApiError("invalid_request", 400);
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
      if (url.pathname === "/github/callback") {
        redirect(response, webLocation(options.webOrigin, "/home", "GitHub connection could not be verified."));
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
      const apiError = error instanceof ApiError ? error : new ApiError("internal_error", 500);
      response.statusCode = apiError.status;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ error: apiError.code }));
    }
  });
}

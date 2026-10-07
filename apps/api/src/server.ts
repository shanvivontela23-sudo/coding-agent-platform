import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { completeTenantLogin, type SupabaseAuthClient, type SupabaseIdentity } from "./auth.js";

export type ApiServerOptions = {
  readonly webOrigin: string;
  readonly apiOrigin?: string;
  readonly sessionSecret: string;
  readonly sessionDurationMs: number;
  readonly auth: SupabaseAuthClient;
  readonly resolveMembership: (identity: SupabaseIdentity) => Promise<{ userId: string; organizationId: string }>;
};

function redirect(response: ServerResponse, location: string): void {
  response.statusCode = 303;
  response.setHeader("location", location);
  response.end();
}
function cookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
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

export function createApiServer(options: ApiServerOptions) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", options.apiOrigin ?? "http://localhost:3001");
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
        const completed = await completeTenantLogin({ identity, sessionSecret: options.sessionSecret, sessionDurationMs: options.sessionDurationMs, resolveMembership: options.resolveMembership });
        response.setHeader("set-cookie", cookie("tenant_session", completed.sessionToken, Math.floor(options.sessionDurationMs / 1000)));
        redirect(response, options.webOrigin);
        return;
      }
      if (request.method === "GET" && url.pathname === "/auth/github/start") {
        const flow = options.auth.startGitHubOAuth(`${options.apiOrigin ?? "http://localhost:3001"}/auth/github/callback`);
        response.setHeader("set-cookie", cookie("supabase_oauth_flow", flow.flowCookie, 600));
        redirect(response, flow.authorizationUrl);
        return;
      }
      if (request.method === "GET" && url.pathname === "/auth/github/callback") {
        const code = url.searchParams.get("code");
        const flowId = url.searchParams.get("flow");
        const flowCookie = cookies(request).get("supabase_oauth_flow");
        if (!code || !flowId || !flowCookie) throw new Error("missing Supabase OAuth callback state");
        const identity = await options.auth.completeGitHubOAuth({ code, flowId, flowCookie });
        const completed = await completeTenantLogin({ identity, sessionSecret: options.sessionSecret, sessionDurationMs: options.sessionDurationMs, resolveMembership: options.resolveMembership });
        response.setHeader("set-cookie", [cookie("tenant_session", completed.sessionToken, Math.floor(options.sessionDurationMs / 1000)), "supabase_oauth_flow=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"]);
        redirect(response, options.webOrigin);
        return;
      }
      response.statusCode = 404;
      response.end("not found");
    } catch (error) {
      response.statusCode = 401;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : "authentication failed" }));
    }
  });
}

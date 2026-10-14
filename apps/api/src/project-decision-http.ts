import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { AppError, isSafeErrorCode } from "./errors.js";
import { genericRequestFailureMessage, logRequestError, tenantSessionFromRequest } from "./http-request.js";
import type { ProjectDecisionService } from "./project-decision-service.js";

function json(response: ServerResponse, status: number, value: unknown): void { response.statusCode = status; response.setHeader("content-type", "application/json"); response.end(JSON.stringify(value)); }
function redirect(response: ServerResponse, location: string): void { response.statusCode = 303; response.setHeader("location", location); response.end(); }
function projectLocation(origin: string, projectId: string, error?: string): string { const url = new URL(`/projects/${projectId}`, origin); if (error) url.searchParams.set("error", error); return url.toString(); }

export async function handleProjectDecisionHttpRequest(options: {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly url: URL;
  readonly webOrigin: string;
  readonly sessionSecret: string;
  readonly service: ProjectDecisionService;
}): Promise<boolean> {
  const listMatch = options.request.method === "GET" ? options.url.pathname.match(/^\/api\/projects\/([0-9a-f-]+)\/decisions$/i) : null;
  const supersedeMatch = options.request.method === "POST" ? options.url.pathname.match(/^\/projects\/([0-9a-f-]+)\/decisions\/([0-9a-f-]+)\/supersede$/i) : null;
  if (!listMatch && !supersedeMatch) return false;
  const projectId = listMatch?.[1] ?? supersedeMatch?.[1] ?? "";
  try {
    const session = tenantSessionFromRequest(options.request, options.sessionSecret);
    if (listMatch) { json(options.response, 200, await options.service.list(session, projectId)); return true; }
    await options.service.supersede(session, projectId, supersedeMatch![2]!);
    redirect(options.response, projectLocation(options.webOrigin, projectId)); return true;
  } catch (error) {
    const logged = logRequestError(options.request, options.url.pathname, error);
    if (listMatch) {
      const status = error instanceof AppError ? error.status : isSafeErrorCode(error, "AUTH_REQUIRED") ? 401 : 500;
      const message = error instanceof AppError ? error.publicMessage : genericRequestFailureMessage(logged.requestId);
      json(options.response, status, { code: logged.code, error: message }); return true;
    }
    const message = error instanceof AppError ? error.publicMessage : `Unable to update project knowledge. ${genericRequestFailureMessage(logged.requestId)}`;
    redirect(options.response, projectLocation(options.webOrigin, projectId, message)); return true;
  }
}
export function attachProjectDecisionRoutes(server: Server, options: {
  readonly apiOrigin: string;
  readonly webOrigin: string;
  readonly sessionSecret: string;
  readonly service: ProjectDecisionService;
}): Server {
  const existing = server.listeners("request") as Array<(request: IncomingMessage, response: ServerResponse) => void | Promise<void>>;
  if (existing.length !== 1) throw new Error("product server must have exactly one request listener before project decision routes are attached");
  const productHandler = existing[0]!;
  server.removeAllListeners("request");
  server.on("request", (request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", options.apiOrigin);
      if (await handleProjectDecisionHttpRequest({ request, response, url, webOrigin: options.webOrigin, sessionSecret: options.sessionSecret, service: options.service })) return;
      await productHandler.call(server, request, response);
    })().catch(() => {
      if (!response.headersSent) response.statusCode = 500;
      if (!response.writableEnded) response.end("internal error");
    });
  });
  return server;
}

import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { AppError, isSafeErrorCode } from "./errors.js";
import { genericRequestFailureMessage, logRequestError, tenantSessionFromRequest } from "./http-request.js";
import type { TaskExecutionService } from "./task-execution-service.js";
import { TaskPublicationInProgressError, type TaskPublicationService } from "./task-publication-service.js";
import type { createTaskZipResultService } from "./task-zip-result.js";

type TaskZipResultService = ReturnType<typeof createTaskZipResultService>;
function json(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
}
function redirect(response: ServerResponse, location: string): void { response.statusCode = 303; response.setHeader("location", location); response.end(); }

async function handleZipResult(request: IncomingMessage, response: ServerResponse, url: URL, taskId: string, action: string, options: { readonly apiOrigin: string; readonly sessionSecret: string; readonly zipResultService: TaskZipResultService }): Promise<boolean> {
  const session = tenantSessionFromRequest(request, options.sessionSecret);
  if (action === "download" && request.method === "GET") {
    const token = url.searchParams.get("token") ?? "";
    const result = await options.zipResultService.download(session, taskId, token);
    response.statusCode = 200; response.setHeader("content-type", "application/zip"); response.setHeader("content-disposition", `attachment; filename="${result.filename}"`); response.end(Buffer.from(result.bytes)); return true;
  }
  if (action === "patch" && request.method === "GET") {
    const patch = await options.zipResultService.getPatch(session, taskId);
    response.statusCode = 200; response.setHeader("content-type", "text/plain; charset=utf-8"); response.setHeader("content-disposition", `attachment; filename="dhara-${taskId}.patch"`); response.end(patch); return true;
  }
  if (request.method !== "POST") return false;
  if (action === "accept-unproven") { json(response, 200, { zipResult: await options.zipResultService.acceptUnproven(session, taskId) }); return true; }
  if (action === "promote") { json(response, 200, { zipResult: await options.zipResultService.promote(session, taskId) }); return true; }
  if (action === "download-token") {
    const token = await options.zipResultService.issueDownloadToken(session, taskId);
    redirect(response, `${options.apiOrigin}/api/tasks/${encodeURIComponent(taskId)}/execution/zip-result/download?token=${encodeURIComponent(token)}`); return true;
  }
  return false;
}

async function handle(request: IncomingMessage, response: ServerResponse, options: {
  readonly apiOrigin: string;
  readonly sessionSecret: string;
  readonly service: TaskExecutionService;
  readonly publicationService?: TaskPublicationService;
  readonly zipResultService?: TaskZipResultService;
}): Promise<boolean> {
  const url = new URL(request.url ?? "/", options.apiOrigin);
  const zipMatch = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]+)\/execution\/zip-result\/(accept-unproven|promote|download-token|download|patch)$/i);
  if (zipMatch) {
    if (!options.zipResultService) throw new AppError("ZIP_RESULT_UNAVAILABLE", "Updated ZIP delivery is unavailable.", 503);
    try { return await handleZipResult(request, response, url, zipMatch[1]!, zipMatch[2]!, { apiOrigin: options.apiOrigin, sessionSecret: options.sessionSecret, zipResultService: options.zipResultService }); }
    catch (error) {
      const logged = logRequestError(request, url.pathname, error);
      if (isSafeErrorCode(error, "AUTH_REQUIRED")) { json(response, 401, { code: "AUTH_REQUIRED", error: "Please sign in to continue." }); return true; }
      const status = error instanceof AppError ? error.status : 500;
      json(response, status, { code: logged.code, error: error instanceof AppError ? error.publicMessage : genericRequestFailureMessage(logged.requestId) }); return true;
    }
  }

  const match = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]+)\/execution(?:\/(start|cancel|publication))?$/i);
  if (!match) return false;
  const taskId = match[1]!;
  const action = match[2];
  if ((!action && request.method !== "GET") || (action && request.method !== "POST")) return false;

  try {
    const session = tenantSessionFromRequest(request, options.sessionSecret);
    if (!action) {
      const [execution, readiness, publication] = await Promise.all([
        options.service.get(session, taskId),
        options.service.readiness(session, taskId),
        options.publicationService?.get(session, taskId) ?? Promise.resolve(null),
      ]);
      let zipResult = null; let zipResultError: { code: string; error: string } | null = null;
      if (options.zipResultService) {
        try { zipResult = await options.zipResultService.getOrCreate(session, taskId); }
        catch (error) { if (error instanceof AppError) zipResultError = { code: error.code, error: error.publicMessage }; else throw error; }
      }
      if (!options.publicationService && !options.zipResultService && readiness.implementationBlocker === null) json(response, 200, { execution });
      else json(response, 200, { execution, ...readiness, publication, zipResult, zipResultError });
      return true;
    }
    if (action === "start") {
      const result = await options.service.start(session, taskId);
      json(response, result.created ? 201 : 200, result);
      return true;
    }
    if (action === "publication") {
      if (!options.publicationService) throw new AppError("TASK_PUBLICATION_UNAVAILABLE", "GitHub publication is unavailable.", 503);
      json(response, 200, { publication: await options.publicationService.publish(session, taskId) });
      return true;
    }
    json(response, 200, { execution: await options.service.cancel(session, taskId) });
    return true;
  } catch (error) {
    const logged = logRequestError(request, url.pathname, error);
    if (isSafeErrorCode(error, "AUTH_REQUIRED")) {
      json(response, 401, { code: "AUTH_REQUIRED", error: "Please sign in to continue." });
      return true;
    }
    if (error instanceof TaskPublicationInProgressError) {
      json(response, 409, { code: error.code, error: error.publicMessage, publication: error.publication });
      return true;
    }
    const status = error instanceof AppError ? error.status : 500;
    json(response, status, { code: logged.code, error: error instanceof AppError ? error.publicMessage : genericRequestFailureMessage(logged.requestId) });
    return true;
  }
}

export function attachTaskExecutionRoutes(server: Server, options: {
  readonly apiOrigin: string;
  readonly sessionSecret: string;
  readonly service: TaskExecutionService;
  readonly publicationService?: TaskPublicationService;
  readonly zipResultService?: TaskZipResultService;
}): Server {
  const existing = server.listeners("request") as Array<(request: IncomingMessage, response: ServerResponse) => void | Promise<void>>;
  if (existing.length !== 1) throw new Error("server must have exactly one request listener before execution routes are attached");
  const previous = existing[0]!;
  server.removeAllListeners("request");
  server.on("request", (request, response) => {
    void (async () => {
      if (await handle(request, response, options)) return;
      await previous.call(server, request, response);
    })().catch(() => {
      if (!response.headersSent) response.statusCode = 500;
      if (!response.writableEnded) response.end("internal error");
    });
  });
  return server;
}

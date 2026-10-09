import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { AppError, isSafeErrorCode } from "./errors.js";
import { genericRequestFailureMessage, logRequestError, tenantSessionFromRequest } from "./http-request.js";
import type { TaskExecutionService } from "./task-execution-service.js";

function json(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
}

async function handle(request: IncomingMessage, response: ServerResponse, options: {
  readonly apiOrigin: string;
  readonly sessionSecret: string;
  readonly service: TaskExecutionService;
}): Promise<boolean> {
  const url = new URL(request.url ?? "/", options.apiOrigin);
  const match = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]+)\/execution(?:\/(start|cancel))?$/i);
  if (!match) return false;
  const taskId = match[1]!;
  const action = match[2];
  if ((!action && request.method !== "GET") || (action && request.method !== "POST")) return false;

  try {
    const session = tenantSessionFromRequest(request, options.sessionSecret);
    if (!action) {
      json(response, 200, { execution: await options.service.get(session, taskId) });
      return true;
    }
    if (action === "start") {
      const result = await options.service.start(session, taskId);
      json(response, result.created ? 201 : 200, result);
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
    const status = error instanceof AppError ? error.status : 500;
    json(response, status, { code: logged.code, error: error instanceof AppError ? error.publicMessage : genericRequestFailureMessage(logged.requestId) });
    return true;
  }
}

export function attachTaskExecutionRoutes(server: Server, options: {
  readonly apiOrigin: string;
  readonly sessionSecret: string;
  readonly service: TaskExecutionService;
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

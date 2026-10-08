import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { handleTaskHttpRequest } from "./task-http.js";
import type { TaskPlanningService, TaskReadService, TaskService } from "./task-service.js";

export function attachTaskRoutes(server: Server, options: {
  readonly apiOrigin: string;
  readonly webOrigin: string;
  readonly sessionSecret: string;
  readonly service?: TaskService;
  readonly readService?: TaskReadService;
  readonly planningService?: TaskPlanningService;
}): Server {
  const existing = server.listeners("request") as Array<(request: IncomingMessage, response: ServerResponse) => void | Promise<void>>;
  if (existing.length !== 1) throw new Error("product server must have exactly one request listener before task routes are attached");
  const productHandler = existing[0]!;
  server.removeAllListeners("request");
  server.on("request", (request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", options.apiOrigin);
      if (await handleTaskHttpRequest({ request, response, url, webOrigin: options.webOrigin, sessionSecret: options.sessionSecret, service: options.service, readService: options.readService, planningService: options.planningService })) return;
      await productHandler.call(server, request, response);
    })().catch(() => {
      if (!response.headersSent) response.statusCode = 500;
      if (!response.writableEnded) response.end("internal error");
    });
  });
  return server;
}

import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { handleProduct07HttpRequest } from "./product-07-http.js";
import type { Product07Service } from "./product-07-service.js";

export function attachProduct07Routes(server: Server, options: {
  readonly apiOrigin: string;
  readonly webOrigin: string;
  readonly sessionSecret: string;
  readonly service: Product07Service;
  readonly maxUploadRequestBytes: number;
}): Server {
  const existing = server.listeners("request") as Array<(request: IncomingMessage, response: ServerResponse) => void | Promise<void>>;
  if (existing.length !== 1) throw new Error("product server must have exactly one request listener before Product 07 routes are attached");
  const productHandler = existing[0]!;
  server.removeAllListeners("request");
  server.on("request", (request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", options.apiOrigin);
      if (await handleProduct07HttpRequest({ request, response, url, apiOrigin: options.apiOrigin, webOrigin: options.webOrigin, sessionSecret: options.sessionSecret, service: options.service, maxUploadRequestBytes: options.maxUploadRequestBytes })) return;
      await productHandler.call(server, request, response);
    })().catch(() => {
      if (!response.headersSent) response.statusCode = 500;
      if (!response.writableEnded) response.end("internal error");
    });
  });
  return server;
}

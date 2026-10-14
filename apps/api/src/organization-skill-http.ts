import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { AppError, isSafeErrorCode } from "./errors.js";
import { genericRequestFailureMessage, logRequestError, tenantSessionFromRequest } from "./http-request.js";
import type { OrganizationSkillService } from "./organization-skill-service.js";

const maxFormBytes = 16_384;
function json(response: ServerResponse, status: number, value: unknown): void { response.statusCode = status; response.setHeader("content-type", "application/json"); response.end(JSON.stringify(value)); }
function redirect(response: ServerResponse, location: string): void { response.statusCode = 303; response.setHeader("location", location); response.end(); }
function rulesLocation(origin: string, message?: { readonly error?: string; readonly notice?: string }): string {
  const url = new URL("/rules", origin);
  if (message?.error) url.searchParams.set("error", message.error);
  if (message?.notice) url.searchParams.set("notice", message.notice);
  return url.toString();
}
async function form(request: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > maxFormBytes) throw new AppError("ORGANIZATION_RULE_INVALID", "That rule is too long.", 413);
    chunks.push(buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}
function ruleInput(values: URLSearchParams) {
  const stacks = values.getAll("stacks").map((value) => value.trim()).filter(Boolean);
  return { title: values.get("title") ?? "", body: values.get("body") ?? "", appliesToStacks: stacks.length > 0 ? stacks : null };
}

export async function handleOrganizationSkillHttpRequest(options: {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly url: URL;
  readonly webOrigin: string;
  readonly sessionSecret: string;
  readonly service: OrganizationSkillService;
}): Promise<boolean> {
  const { request, response, url } = options;
  const viewRoute = request.method === "GET" && url.pathname === "/api/organization/rules";
  const createRoute = request.method === "POST" && url.pathname === "/organization/rules";
  const actionMatch = request.method === "POST" ? url.pathname.match(/^\/organization\/rules\/([0-9a-f-]+)\/(update|enable|disable|delete)$/i) : null;
  if (!viewRoute && !createRoute && !actionMatch) return false;
  try {
    const session = tenantSessionFromRequest(request, options.sessionSecret);
    if (viewRoute) { json(response, 200, await options.service.view(session)); return true; }
    if (createRoute) { await options.service.create(session, ruleInput(await form(request))); redirect(response, rulesLocation(options.webOrigin, { notice: "Rule added. Dhara applies it to new tasks." })); return true; }
    const [, skillId, action] = actionMatch!;
    if (action === "update") await options.service.update(session, skillId!, ruleInput(await form(request)));
    else if (action === "enable") await options.service.setEnabled(session, skillId!, true);
    else if (action === "disable") await options.service.setEnabled(session, skillId!, false);
    else await options.service.remove(session, skillId!);
    redirect(response, rulesLocation(options.webOrigin)); return true;
  } catch (error) {
    const logged = logRequestError(request, url.pathname, error);
    if (viewRoute) {
      const status = error instanceof AppError ? error.status : isSafeErrorCode(error, "AUTH_REQUIRED") ? 401 : 500;
      json(response, status, { code: logged.code, error: error instanceof AppError ? error.publicMessage : genericRequestFailureMessage(logged.requestId) }); return true;
    }
    if (isSafeErrorCode(error, "AUTH_REQUIRED")) { redirect(response, new URL("/?error=Please%20sign%20in%20to%20continue.", options.webOrigin).toString()); return true; }
    const message = error instanceof AppError ? error.publicMessage : `Unable to update coding rules. ${genericRequestFailureMessage(logged.requestId)}`;
    redirect(response, rulesLocation(options.webOrigin, { error: message })); return true;
  }
}

export function attachOrganizationSkillRoutes(server: Server, options: {
  readonly apiOrigin: string;
  readonly webOrigin: string;
  readonly sessionSecret: string;
  readonly service: OrganizationSkillService;
}): Server {
  const existing = server.listeners("request") as Array<(request: IncomingMessage, response: ServerResponse) => void | Promise<void>>;
  if (existing.length !== 1) throw new Error("product server must have exactly one request listener before organization rule routes are attached");
  const productHandler = existing[0]!;
  server.removeAllListeners("request");
  server.on("request", (request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", options.apiOrigin);
      if (await handleOrganizationSkillHttpRequest({ request, response, url, webOrigin: options.webOrigin, sessionSecret: options.sessionSecret, service: options.service })) return;
      await productHandler.call(server, request, response);
    })().catch(() => {
      if (!response.headersSent) response.statusCode = 500;
      if (!response.writableEnded) response.end("internal error");
    });
  });
  return server;
}

import type { IncomingMessage, ServerResponse } from "node:http";
import { verifySessionToken, type SessionIdentity } from "./auth.js";
import type { TaskPlanningService, TaskReadService, TaskService } from "./task-service.js";

function cookies(request: IncomingMessage): Map<string, string> {
  const values = new Map<string, string>();
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0) values.set(part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim()));
  }
  return values;
}
async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 128 * 1024) throw new Error("task request body too large");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}
function session(request: IncomingMessage, secret: string): SessionIdentity {
  const token = cookies(request).get("tenant_session");
  if (!token) throw new Error("authentication required");
  return verifySessionToken(token, secret);
}
function json(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status; response.setHeader("content-type", "application/json"); response.end(JSON.stringify(value));
}
function redirect(response: ServerResponse, location: string): void { response.statusCode = 303; response.setHeader("location", location); response.end(); }
function webLocation(origin: string, path: string, error?: string): string {
  const url = new URL(path, origin); if (error) url.searchParams.set("error", error); return url.toString().replace(/\/$/, path === "/" ? "" : "/");
}

export async function handleTaskHttpRequest(options: {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly url: URL;
  readonly webOrigin: string;
  readonly sessionSecret: string;
  readonly service?: TaskService | undefined;
  readonly readService?: TaskReadService | undefined;
  readonly planningService?: TaskPlanningService | undefined;
}): Promise<boolean> {
  const { request, response, url } = options;
  const createMatch = request.method === "POST" ? url.pathname.match(/^\/projects\/([0-9a-f-]+)\/tasks$/i) : null;
  const detailMatch = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]+)$/i);
  const answerMatch = request.method === "POST" ? url.pathname.match(/^\/tasks\/([0-9a-f-]+)\/answers$/i) : null;
  const approveMatch = request.method === "POST" ? url.pathname.match(/^\/tasks\/([0-9a-f-]+)\/approve$/i) : null;
  const configurationRoute = request.method === "GET" && url.pathname === "/api/tasks/configuration";
  const listRoute = request.method === "GET" && url.pathname === "/api/tasks";
  const taskRoute = Boolean(createMatch || detailMatch || answerMatch || approveMatch || configurationRoute || listRoute);
  if (!taskRoute) return false;

  const readService = options.readService ?? options.service;
  const planningService = options.planningService ?? options.service;

  try {
    const identity = session(request, options.sessionSecret);
    if (configurationRoute) {
      json(response, 200, { planningConfigured: Boolean(planningService) }); return true;
    }
    if (listRoute) {
      if (!readService) { json(response, 503, { code: "TASK_READ_NOT_CONFIGURED", error: "Task reading is not configured." }); return true; }
      json(response, 200, { tasks: await readService.list(identity) }); return true;
    }
    if (detailMatch) {
      if (!readService) { json(response, 503, { code: "TASK_READ_NOT_CONFIGURED", error: "Task reading is not configured." }); return true; }
      const task = await readService.get(identity, detailMatch[1]!);
      if (!task) { json(response, 404, { code: "TASK_NOT_FOUND", error: "Task was not found." }); return true; }
      json(response, 200, { task }); return true;
    }
    if (createMatch) {
      if (!planningService) {
        redirect(response, webLocation(options.webOrigin, `/projects/${createMatch[1]}/tasks/new`, "Task planning is not configured.")); return true;
      }
      const form = new URLSearchParams(await body(request));
      const created = await planningService.create(identity, createMatch[1]!, form.get("ticket") ?? "");
      redirect(response, webLocation(options.webOrigin, `/tasks/${created.taskId}`)); return true;
    }
    if (answerMatch) {
      if (!planningService) {
        redirect(response, webLocation(options.webOrigin, `/tasks/${answerMatch[1]}`, "Task planning is not configured.")); return true;
      }
      const form = new URLSearchParams(await body(request));
      await planningService.answer(identity, answerMatch[1]!, form.get("questionId") ?? "", form.get("answer") ?? "");
      redirect(response, webLocation(options.webOrigin, `/tasks/${answerMatch[1]}`)); return true;
    }
    if (approveMatch) {
      if (!readService) {
        redirect(response, webLocation(options.webOrigin, `/tasks/${approveMatch[1]}`, "Unable to update that task.")); return true;
      }
      const form = new URLSearchParams(await body(request));
      await readService.approve(identity, approveMatch[1]!, { whatIUnderstand: form.get("whatIUnderstand") ?? "", proposedApproach: form.get("proposedApproach") ?? "" });
      redirect(response, webLocation(options.webOrigin, `/tasks/${approveMatch[1]}`)); return true;
    }
    return false;
  } catch (error) {
    console.error(JSON.stringify({ event: "api_error", method: request.method ?? "UNKNOWN", path: url.pathname, code: "TASK_REQUEST_FAILED" }));
    if (url.pathname.startsWith("/api/")) { json(response, 401, { code: "TASK_REQUEST_FAILED", error: "Request failed." }); return true; }
    const fallback = createMatch ? `/projects/${createMatch[1]}/tasks/new` : answerMatch ? `/tasks/${answerMatch[1]}` : approveMatch ? `/tasks/${approveMatch[1]}` : "/tasks";
    redirect(response, webLocation(options.webOrigin, fallback, error instanceof Error && /not configured/i.test(error.message) ? "Task planning is not configured." : "Unable to update that task."));
    return true;
  }
}

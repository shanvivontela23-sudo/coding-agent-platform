import type { IncomingMessage, ServerResponse } from "node:http";
import { AppError, isSafeErrorCode } from "./errors.js";
import { genericRequestFailureMessage, logRequestError, tenantSessionFromRequest } from "./http-request.js";
import type { Product07Service } from "./product-07-service.js";

async function readBytes(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declared = Number(request.headers["content-length"]); if (Number.isFinite(declared) && declared > maxBytes) throw new AppError("UPLOAD_TOO_LARGE", "ZIP upload exceeds the configured limit.", 413);
  const chunks: Buffer[] = []; let total = 0;
  for await (const chunk of request) { const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); total += bytes.length; if (total > maxBytes) throw new AppError("UPLOAD_TOO_LARGE", "ZIP upload exceeds the configured limit.", 413); chunks.push(bytes); }
  return Buffer.concat(chunks, total);
}
function json(response: ServerResponse, status: number, value: unknown): void { response.statusCode = status; response.setHeader("content-type", "application/json"); response.end(JSON.stringify(value)); }
function redirect(response: ServerResponse, location: string): void { response.statusCode = 303; response.setHeader("location", location); response.end(); }
function webLocation(origin: string, path: string, error?: string): string { const url = new URL(path, origin); if (error) url.searchParams.set("error", error); return url.toString(); }

export async function handleProduct07HttpRequest(options: {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly url: URL;
  readonly apiOrigin: string;
  readonly webOrigin: string;
  readonly sessionSecret: string;
  readonly service: Product07Service;
  readonly maxUploadRequestBytes: number;
}): Promise<boolean> {
  const { request, response, url } = options;
  const upload = request.method === "POST" && url.pathname === "/projects/upload";
  const apiProject = request.method === "GET" ? url.pathname.match(/^\/api\/projects\/([0-9a-f-]+)$/i) : null;
  const reanalyse = request.method === "POST" ? url.pathname.match(/^\/projects\/([0-9a-f-]+)\/reanalyse$/i) : null;
  const tokenMatch = request.method === "POST" ? url.pathname.match(/^\/projects\/([0-9a-f-]+)\/versions\/([0-9a-f-]+)\/download-token$/i) : null;
  const download = request.method === "GET" && url.pathname === "/projects/download";
  const deleteMatch = request.method === "POST" ? url.pathname.match(/^\/projects\/([0-9a-f-]+)\/delete$/i) : null;
  if (!upload && !apiProject && !reanalyse && !tokenMatch && !download && !deleteMatch) return false;

  try {
    const identity = tenantSessionFromRequest(request, options.sessionSecret);
    if (apiProject) {
      const project = await options.service.getUploadProject(identity, apiProject[1]!);
      if (!project) return false;
      json(response, 200, project); return true;
    }
    if (upload) {
      const contentType = request.headers["content-type"] ?? "";
      if (!contentType.toLowerCase().startsWith("multipart/form-data")) throw new AppError("INVALID_UPLOAD_ARCHIVE", "ZIP upload form is invalid.", 400);
      const body = await readBytes(request, options.maxUploadRequestBytes);
      const copied = Uint8Array.from(body);
      const form = await new Response(copied.buffer, { headers: { "content-type": contentType } }).formData();
      const name = String(form.get("name") ?? "").trim(); const file = form.get("zip");
      if (!(file instanceof Blob)) throw new AppError("INVALID_UPLOAD_ARCHIVE", "Select a ZIP archive to upload.", 400);
      const created = await options.service.createUploadProject(identity, { name, zip: new Uint8Array(await file.arrayBuffer()) });
      redirect(response, webLocation(options.webOrigin, `/projects/${created.projectId}`)); return true;
    }
    if (reanalyse) {
      await options.service.reanalyse(identity, reanalyse[1]!);
      redirect(response, webLocation(options.webOrigin, `/projects/${reanalyse[1]}`)); return true;
    }
    if (tokenMatch) {
      const token = await options.service.issueDownloadToken(identity, tokenMatch[1]!, tokenMatch[2]!);
      const location = new URL("/projects/download", options.apiOrigin); location.searchParams.set("token", token); redirect(response, location.toString()); return true;
    }
    if (download) {
      const downloaded = await options.service.download(identity, url.searchParams.get("token") ?? "");
      response.statusCode = 200; response.setHeader("content-type", "application/zip"); response.setHeader("content-disposition", `attachment; filename="${downloaded.filename.replaceAll('"', '')}"`); response.setHeader("cache-control", "private, no-store"); response.end(Buffer.from(downloaded.bytes)); return true;
    }
    if (deleteMatch) {
      await options.service.deleteUploadProject(identity, deleteMatch[1]!);
      redirect(response, webLocation(options.webOrigin, "/home")); return true;
    }
    return false;
  } catch (error) {
    const logged = logRequestError(request, url.pathname, error);
    if (isSafeErrorCode(error, "AUTH_REQUIRED")) {
      if (apiProject) json(response, 401, { code: "AUTH_REQUIRED", error: "Please sign in to continue." });
      else redirect(response, webLocation(options.webOrigin, "/", "Please sign in to continue."));
      return true;
    }
    if (apiProject) {
      const status = error instanceof AppError ? error.status : 500;
      json(response, status, { code: logged.code, error: error instanceof AppError ? error.publicMessage : genericRequestFailureMessage(logged.requestId) });
      return true;
    }
    const projectId = reanalyse?.[1] ?? tokenMatch?.[1] ?? deleteMatch?.[1];
    const fallback = upload ? "Unable to upload that project." : "Unable to update that project.";
    const publicMessage = error instanceof AppError ? error.publicMessage : `${fallback} ${genericRequestFailureMessage(logged.requestId)}`;
    redirect(response, webLocation(options.webOrigin, projectId ? `/projects/${projectId}` : "/home", publicMessage));
    return true;
  }
}

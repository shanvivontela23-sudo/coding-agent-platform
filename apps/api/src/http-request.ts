import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { verifySessionToken, type SessionIdentity } from "./auth.js";
import { AppError, safeErrorCode, type SafeErrorCode } from "./errors.js";

export function parseRequestCookies(request: IncomingMessage): Map<string, string> {
  const values = new Map<string, string>();
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    if (!name) continue;
    try {
      values.set(name, decodeURIComponent(part.slice(index + 1).trim()));
    } catch {
      // A malformed unrelated cookie must not make the whole request fail.
    }
  }
  return values;
}

export function tenantSessionFromRequest(request: IncomingMessage, secret: string): SessionIdentity {
  const token = parseRequestCookies(request).get("tenant_session");
  if (!token) throw new AppError("AUTH_REQUIRED", "Authentication required.", 401);
  try {
    return verifySessionToken(token, secret);
  } catch {
    throw new AppError("AUTH_REQUIRED", "Authentication required.", 401);
  }
}

export function genericRequestFailureMessage(requestId: string): string {
  return `Something went wrong (ref ${requestId}). Please try again.`;
}

function redact(value: string, redactValues: readonly string[]): string {
  let result = value;
  for (const secret of redactValues) {
    if (secret) result = result.replaceAll(secret, "[REDACTED]");
  }
  return result;
}

export function logRequestError(
  request: IncomingMessage,
  pathname: string,
  error: unknown,
  fallbackCode: SafeErrorCode = "INTERNAL_ERROR",
  redactValues: readonly string[] = [],
): { readonly requestId: string; readonly code: SafeErrorCode } {
  const requestId = randomBytes(3).toString("hex");
  const actual = error instanceof Error ? error : new Error(typeof error === "string" ? error : "Non-Error value thrown");
  const code = safeErrorCode(error, fallbackCode);
  console.error(JSON.stringify({
    event: "api_error",
    requestId,
    method: request.method ?? "UNKNOWN",
    path: pathname,
    code,
    error: {
      name: actual.name,
      message: redact(actual.message, redactValues),
      stack: actual.stack ? redact(actual.stack, redactValues) : null,
    },
  }));
  return { requestId, code };
}

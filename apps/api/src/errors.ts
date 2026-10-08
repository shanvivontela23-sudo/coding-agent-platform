export type SafeErrorCode =
  | "AUTH_REQUIRED"
  | "AUTH_SIGN_IN_FAILED"
  | "GITHUB_STATE_INVALID"
  | "GITHUB_FORBIDDEN"
  | "GITHUB_INSTALLATION_FORBIDDEN"
  | "GITHUB_INSTALLATION_BOUND"
  | "GITHUB_INSTALLATION_DISCONNECTED"
  | "GITHUB_REPOSITORY_FORBIDDEN"
  | "GITHUB_NOT_CONNECTED"
  | "REPOSITORY_TOO_LARGE"
  | "REPOSITORY_INVALID_ARCHIVE"
  | "INVALID_UPLOAD_ARCHIVE"
  | "UPLOAD_TOO_LARGE"
  | "PROJECT_NOT_FOUND"
  | "PROJECT_DOWNLOAD_INVALID"
  | "PROJECT_DELETE_FORBIDDEN"
  | "INTERNAL_ERROR";

const safeCode = /^[A-Z0-9_]{3,48}$/;

export class AppError extends Error {
  readonly code: SafeErrorCode;
  readonly publicMessage: string;
  readonly status: number;

  constructor(code: SafeErrorCode, publicMessage: string, status = 400) {
    super(publicMessage);
    this.name = "AppError";
    this.code = code;
    this.publicMessage = publicMessage;
    this.status = status;
  }
}

export function safeErrorCode(error: unknown, fallback: SafeErrorCode): SafeErrorCode {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === "string" && safeCode.test(code)) return code as SafeErrorCode;
  }
  return fallback;
}

export function isSafeErrorCode(error: unknown, code: SafeErrorCode): boolean {
  return safeErrorCode(error, "INTERNAL_ERROR") === code;
}

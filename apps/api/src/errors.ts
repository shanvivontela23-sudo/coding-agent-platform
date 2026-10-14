export type SafeErrorCode =
  | "AUTH_REQUIRED"
  | "AUTH_SIGN_IN_FAILED"
  | "AUTH_SIGN_UP_FAILED"
  | "GITHUB_STATE_INVALID"
  | "GITHUB_FORBIDDEN"
  | "GITHUB_INSTALLATION_FORBIDDEN"
  | "GITHUB_INSTALLATION_BOUND"
  | "GITHUB_INSTALLATION_DISCONNECTED"
  | "GITHUB_REPOSITORY_FORBIDDEN"
  | "GITHUB_NOT_CONNECTED"
  | "GITHUB_CONTENTS_WRITE_REQUIRED"
  | "REPOSITORY_TOO_LARGE"
  | "REPOSITORY_INVALID_ARCHIVE"
  | "INVALID_UPLOAD_ARCHIVE"
  | "UPLOAD_TOO_LARGE"
  | "PROJECT_NOT_FOUND"
  | "PROJECT_DOWNLOAD_INVALID"
  | "PROJECT_DELETE_FORBIDDEN"
  | "PROJECT_DECISION_FORBIDDEN"
  | "PROJECT_DECISION_NOT_FOUND"
  | "TASK_EXECUTION_NOT_FOUND"
  | "TASK_EXECUTION_FORBIDDEN"
  | "TASK_EXECUTION_NOT_READY"
  | "TASK_EXECUTION_REANALYSIS_REQUIRED"
  | "TASK_EXECUTION_SOURCE_UNAVAILABLE"
  | "TASK_EXECUTION_NOT_ACTIVE"
  | "TASK_PUBLICATION_NOT_FOUND"
  | "TASK_PUBLICATION_FORBIDDEN"
  | "TASK_PUBLICATION_NOT_ALLOWED"
  | "TASK_RETRY_NOT_ALLOWED"
  | "TASK_PUBLICATION_UNAVAILABLE"
  | "TASK_PUBLICATION_IN_PROGRESS"
  | "TASK_PUBLICATION_FAILED"
  | "ZIP_RESULT_UNAVAILABLE"
  | "ZIP_RESULT_FAILED"
  | "ZIP_PROMOTION_FORBIDDEN"
  | "ZIP_UNPROVEN_ACCEPT_FORBIDDEN"
  | "SOURCE_CHANGED"
  | "PUBLISHED_CONTENT_MISMATCH"
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

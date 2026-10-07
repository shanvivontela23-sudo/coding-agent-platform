export type ApiErrorCode =
  | "auth_failed"
  | "auth_required"
  | "forbidden"
  | "invalid_request"
  | "not_found"
  | "conflict"
  | "github_state_invalid"
  | "github_installation_unverified"
  | "github_installation_conflict"
  | "github_provider_failed"
  | "internal_error";

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;

  constructor(code: ApiErrorCode, status = 400) {
    super(code);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

export function safeErrorCode(error: unknown): ApiErrorCode {
  return error instanceof ApiError ? error.code : "internal_error";
}

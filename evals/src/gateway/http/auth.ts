import type { RunTokenClaims, RunTokenService } from "../run-token.js";

export type HarnessAuthentication = {
  readonly token: string;
  readonly claims: RunTokenClaims;
};

function bearerToken(value: string | null): string | null {
  if (value === null) return null;
  const match = /^Bearer ([^\s]+)$/i.exec(value.trim());
  if (!match) throw new Error("authorization header must use Bearer token");
  return match[1]!;
}

export function authenticateHarnessRequest(
  headers: Headers,
  tokenService: RunTokenService,
): HarnessAuthentication {
  const bearer = bearerToken(headers.get("authorization"));
  const apiKey = headers.get("x-api-key")?.trim() || null;
  if (!bearer && !apiKey) throw new Error("run credential is required");
  if (bearer && apiKey && bearer !== apiKey) {
    throw new Error("conflicting run credentials");
  }
  const token = bearer ?? apiKey!;
  return { token, claims: tokenService.verifyClaims(token) };
}

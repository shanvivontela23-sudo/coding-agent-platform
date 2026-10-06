import type { RunTokenClaims, RunTokenService } from "../run-token.js";

export type HarnessHeaders = Readonly<Record<string, string | undefined>>;

function header(headers: HarnessHeaders, name: string): string | undefined {
  const expected = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === expected) return value;
  }
  return undefined;
}

function bearerToken(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const match = /^Bearer\s+([^\s]+)$/i.exec(value.trim());
  if (!match?.[1]) throw new Error("invalid authorization header");
  return match[1];
}

export function authenticateHarnessRequest(
  headers: HarnessHeaders,
  tokenService: RunTokenService,
): { readonly token: string; readonly claims: RunTokenClaims } {
  const bearer = bearerToken(header(headers, "authorization"));
  const apiKey = header(headers, "x-api-key")?.trim();
  if (apiKey !== undefined && apiKey.length === 0) {
    throw new Error("invalid x-api-key header");
  }
  if (!bearer && !apiKey) throw new Error("run credential is required");
  if (bearer && apiKey && bearer !== apiKey) {
    throw new Error("run credentials conflict");
  }
  const token = bearer ?? apiKey!;
  return { token, claims: tokenService.verifyClaims(token) };
}

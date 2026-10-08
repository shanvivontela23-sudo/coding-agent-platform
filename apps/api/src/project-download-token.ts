import { createHmac, timingSafeEqual } from "node:crypto";

export type ProjectDownloadClaims = {
  readonly version: 1;
  readonly organizationId: string;
  readonly userId: string;
  readonly projectId: string;
  readonly projectVersionId: string;
  readonly expiresAtMs: number;
};

function encode(value: unknown): string { return Buffer.from(JSON.stringify(value), "utf8").toString("base64url"); }
function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class ProjectDownloadTokenService {
  private readonly secret: string;
  private readonly nowMs: () => number;
  constructor(options: { readonly secret: string; readonly nowMs?: () => number }) {
    if (options.secret.length < 32) throw new Error("download token secret must be at least 32 characters");
    this.secret = options.secret; this.nowMs = options.nowMs ?? Date.now;
  }
  private sign(payload: string): string { return createHmac("sha256", this.secret).update(payload).digest("base64url"); }
  issue(input: Omit<ProjectDownloadClaims, "version" | "expiresAtMs">, ttlMs = 5 * 60_000): string {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > 15 * 60_000) throw new Error("download token ttl is invalid");
    const payload = encode({ version: 1, ...input, expiresAtMs: this.nowMs() + ttlMs } satisfies ProjectDownloadClaims);
    return `${payload}.${this.sign(payload)}`;
  }
  verify(token: string): ProjectDownloadClaims {
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra !== undefined || !safeEqual(signature, this.sign(payload))) throw new Error("download token is invalid");
    let claims: ProjectDownloadClaims;
    try { claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as ProjectDownloadClaims; } catch { throw new Error("download token is invalid"); }
    if (claims.version !== 1 || !claims.organizationId || !claims.userId || !claims.projectId || !claims.projectVersionId || !Number.isFinite(claims.expiresAtMs)) throw new Error("download token is invalid");
    if (this.nowMs() >= claims.expiresAtMs) throw new Error("download token has expired");
    return claims;
  }
}

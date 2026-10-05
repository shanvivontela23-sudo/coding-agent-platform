import { createHmac, timingSafeEqual } from "node:crypto";

export type RunTokenClaims = {
  readonly version: 1;
  readonly runId: string;
  readonly expiresAtMs: number;
};

export type RunTokenServiceOptions = {
  readonly secret: string;
  readonly clock?: () => number;
};

function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

export class RunTokenService {
  private readonly secret: string;
  private readonly clock: () => number;

  constructor(options: RunTokenServiceOptions) {
    if (options.secret.length < 32) {
      throw new Error("run token secret must be at least 32 characters");
    }
    this.secret = options.secret;
    this.clock = options.clock ?? Date.now;
  }

  issue(runId: string, expiresAtMs: number): string {
    if (!runId.trim()) throw new Error("runId is required");
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= this.clock()) {
      throw new Error("run token expiry must be in the future");
    }

    const claims: RunTokenClaims = {
      version: 1,
      runId,
      expiresAtMs,
    };
    const payload = encode(JSON.stringify(claims));
    const signature = this.sign(payload);
    return `${payload}.${signature}`;
  }

  verify(token: string, expectedRunId: string): RunTokenClaims {
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra !== undefined) {
      throw new Error("run token is invalid");
    }

    const expectedSignature = this.sign(payload);
    const actualBytes = Buffer.from(signature, "utf8");
    const expectedBytes = Buffer.from(expectedSignature, "utf8");
    if (
      actualBytes.length !== expectedBytes.length ||
      !timingSafeEqual(actualBytes, expectedBytes)
    ) {
      throw new Error("run token is invalid");
    }

    let claims: RunTokenClaims;
    try {
      claims = JSON.parse(decode(payload)) as RunTokenClaims;
    } catch {
      throw new Error("run token is invalid");
    }

    if (
      claims.version !== 1 ||
      typeof claims.runId !== "string" ||
      typeof claims.expiresAtMs !== "number"
    ) {
      throw new Error("run token is invalid");
    }
    if (claims.runId !== expectedRunId) {
      throw new Error(`run token is not valid for ${expectedRunId}`);
    }
    if (this.clock() >= claims.expiresAtMs) {
      throw new Error("run token has expired");
    }

    return claims;
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.secret)
      .update(payload)
      .digest("base64url");
  }
}

import { createHash } from "node:crypto";

export type RunTokenBucketOptions = {
  readonly ratePerMinute: number;
  readonly burst: number;
  readonly clock?: () => number;
};

type BucketState = {
  tokens: number;
  updatedAtMs: number;
};

function tokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class RunTokenBucket {
  private readonly refillPerMs: number;
  private readonly burst: number;
  private readonly clock: () => number;
  private readonly buckets = new Map<string, BucketState>();

  constructor(options: RunTokenBucketOptions) {
    if (!Number.isFinite(options.ratePerMinute) || options.ratePerMinute <= 0) {
      throw new Error("ratePerMinute must be positive");
    }
    if (!Number.isInteger(options.burst) || options.burst <= 0) {
      throw new Error("burst must be a positive integer");
    }
    this.refillPerMs = options.ratePerMinute / 60_000;
    this.burst = options.burst;
    this.clock = options.clock ?? Date.now;
  }

  consume(token: string): boolean {
    const now = this.clock();
    const key = tokenDigest(token);
    const existing = this.buckets.get(key) ?? {
      tokens: this.burst,
      updatedAtMs: now,
    };
    const elapsed = Math.max(0, now - existing.updatedAtMs);
    const available = Math.min(
      this.burst,
      existing.tokens + elapsed * this.refillPerMs,
    );
    if (available < 1) {
      this.buckets.set(key, { tokens: available, updatedAtMs: now });
      return false;
    }
    this.buckets.set(key, { tokens: available - 1, updatedAtMs: now });
    return true;
  }

  toJSON(): { readonly bucketCount: number } {
    return { bucketCount: this.buckets.size };
  }
}

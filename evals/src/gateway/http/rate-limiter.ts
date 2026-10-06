import { createHash } from "node:crypto";

export type RunTokenBucketOptions = {
  readonly ratePerMinute: number;
  readonly burst: number;
  readonly clock?: () => number;
};

type Bucket = {
  tokens: number;
  updatedAtMs: number;
};

export class RunTokenBucket {
  private readonly refillPerMs: number;
  private readonly burst: number;
  private readonly clock: () => number;
  private readonly buckets = new Map<string, Bucket>();

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

  consume(rawToken: string): boolean {
    const key = createHash("sha256").update(rawToken).digest("hex");
    const now = this.clock();
    const bucket = this.buckets.get(key) ?? {
      tokens: this.burst,
      updatedAtMs: now,
    };
    const elapsed = Math.max(0, now - bucket.updatedAtMs);
    bucket.tokens = Math.min(
      this.burst,
      bucket.tokens + elapsed * this.refillPerMs,
    );
    bucket.updatedAtMs = now;
    if (bucket.tokens < 1) {
      this.buckets.set(key, bucket);
      return false;
    }
    bucket.tokens -= 1;
    this.buckets.set(key, bucket);
    return true;
  }
}

export const SANDBOX_LIFETIME_MARGIN_MS = 5 * 60_000;
export const DEFAULT_SETUP_TIMEOUT_MS = 10 * 60_000;

export function sandboxLifetimeMs(input: {
  readonly setupTimeoutMs: number;
  readonly runTimeoutMs: number;
}): number {
  if (!Number.isFinite(input.setupTimeoutMs) || input.setupTimeoutMs <= 0) {
    throw new Error("setup timeout must be positive");
  }
  if (!Number.isFinite(input.runTimeoutMs) || input.runTimeoutMs <= 0) {
    throw new Error("run timeout must be positive");
  }
  return input.setupTimeoutMs + input.runTimeoutMs + SANDBOX_LIFETIME_MARGIN_MS;
}

import type { SandboxPatch, SandboxSession } from "../sandbox/types.js";

export type HarnessRunStatus = "completed" | "asked" | "limit-hit" | "error";

export type HarnessRunRequest = {
  readonly ticketText: string;
  readonly model: string;
  readonly gatewayUrl: string;
  readonly runToken: string;
  readonly maxTurns: number;
  readonly timeoutMs: number;
};

export type HarnessRunOutcome = {
  readonly status: HarnessRunStatus;
  readonly limit: string | null;
  readonly turnsUsed: number;
  readonly wallClockSeconds: number;
  readonly patch: SandboxPatch;
  /** Only for status "error": exit code plus the stderr tail, for operator logs. */
  readonly errorDetail?: string;
  /** The harness's last agent message, when it produced one. */
  readonly finalMessage?: string;
};

export interface HarnessRunner {
  readonly name: "claude-code" | "codex";
  readonly version: string;
  run(session: SandboxSession, request: HarnessRunRequest): Promise<HarnessRunOutcome>;
}

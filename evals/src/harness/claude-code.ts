import type { SandboxSession } from "../sandbox/types.js";
import { executeHarnessCommand, jsonLines, type HarnessRunnerClock } from "./common.js";
import type { HarnessRunOutcome, HarnessRunRequest, HarnessRunner } from "./types.js";

export type ClaudeCodeHarnessRunnerOptions = {
  readonly version: string;
  readonly binary?: string;
  readonly clock?: HarnessRunnerClock;
};

function parseTurns(stdout: string): number {
  let turns = 0;
  for (const event of jsonLines(stdout)) {
    const value = event.num_turns;
    if (typeof value === "number" && Number.isInteger(value)) turns = Math.max(turns, value);
  }
  return turns;
}

function finalMessage(stdout: string): string | null {
  let message: string | null = null;
  for (const event of jsonLines(stdout)) if (typeof event.result === "string") message = event.result;
  return message;
}

function safeBinary(binary: string): string {
  if (!/^[A-Za-z0-9_./-]+$/.test(binary)) throw new Error("invalid Claude Code binary path");
  return binary;
}

export class ClaudeCodeHarnessRunner implements HarnessRunner {
  readonly name = "claude-code" as const;
  readonly version: string;
  private readonly binary: string;
  private readonly clock: HarnessRunnerClock;

  constructor(options: ClaudeCodeHarnessRunnerOptions) {
    if (!options.version.trim()) throw new Error("Claude Code version is required");
    this.version = options.version;
    this.binary = safeBinary(options.binary ?? "claude");
    this.clock = options.clock ?? Date.now;
  }

  async run(session: SandboxSession, request: HarnessRunRequest): Promise<HarnessRunOutcome> {
    const versionGuard = `version_output="$(${this.binary} --version 2>&1)" || exit 86; case "$version_output" in *"$BENCHMARK_HARNESS_VERSION"*) ;; *) printf '%s\n' 'harness_version_mismatch' >&2; exit 86 ;; esac`;
    return await executeHarnessCommand(
      session,
      request,
      {
        command: `${versionGuard}; printf '%s' "$BENCHMARK_TICKET" | ${this.binary} -p --output-format stream-json --verbose --dangerously-skip-permissions --model "$BENCHMARK_MODEL" --max-turns "$BENCHMARK_MAX_TURNS"`,
        env: {
          ANTHROPIC_BASE_URL: request.gatewayUrl,
          ANTHROPIC_AUTH_TOKEN: request.runToken,
          BENCHMARK_TICKET: request.ticketText,
          BENCHMARK_MODEL: request.model,
          BENCHMARK_MAX_TURNS: String(request.maxTurns),
          BENCHMARK_HARNESS_VERSION: this.version,
        },
        parseTurns,
        finalMessage,
      },
      this.clock,
    );
  }
}

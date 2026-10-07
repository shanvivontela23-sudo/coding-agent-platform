import type { SandboxSession } from "../sandbox/types.js";
import { executeHarnessCommand, jsonLines, type HarnessRunnerClock } from "./common.js";
import type { HarnessRunOutcome, HarnessRunRequest, HarnessRunner } from "./types.js";

export type CodexHarnessRunnerOptions = {
  readonly version: string;
  readonly binary?: string;
  readonly clock?: HarnessRunnerClock;
};

function parseTurns(stdout: string): number {
  return jsonLines(stdout).filter((event) => event.type === "turn.completed").length;
}

function finalMessage(stdout: string): string | null {
  let message: string | null = null;
  for (const event of jsonLines(stdout)) {
    if (event.type !== "item.completed") continue;
    const item = event.item;
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (record.type === "agent_message" && typeof record.text === "string") {
      message = record.text;
    }
  }
  return message;
}

function safeBinary(binary: string): string {
  if (!/^[A-Za-z0-9_./-]+$/.test(binary)) throw new Error("invalid Codex binary path");
  return binary;
}

export class CodexHarnessRunner implements HarnessRunner {
  readonly name = "codex" as const;
  readonly version: string;
  private readonly binary: string;
  private readonly clock: HarnessRunnerClock;

  constructor(options: CodexHarnessRunnerOptions) {
    if (!options.version.trim()) throw new Error("Codex version is required");
    this.version = options.version;
    this.binary = safeBinary(options.binary ?? "codex");
    this.clock = options.clock ?? Date.now;
  }

  async run(session: SandboxSession, request: HarnessRunRequest): Promise<HarnessRunOutcome> {
    return await executeHarnessCommand(
      session,
      request,
      {
        command: `printf '%s' "$BENCHMARK_TICKET" | ${this.binary} exec --json --full-auto --model "$BENCHMARK_MODEL" -`,
        env: {
          OPENAI_BASE_URL: request.gatewayUrl,
          OPENAI_API_KEY: request.runToken,
          BENCHMARK_TICKET: request.ticketText,
          BENCHMARK_MODEL: request.model,
          BENCHMARK_MAX_TURNS: String(request.maxTurns),
        },
        parseTurns,
        finalMessage,
      },
      this.clock,
    );
  }
}

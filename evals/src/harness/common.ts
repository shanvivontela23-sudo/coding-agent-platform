import type { SandboxCommand, SandboxPatch, SandboxSession } from "../sandbox/types.js";
import type { HarnessRunOutcome, HarnessRunRequest, HarnessRunStatus } from "./types.js";

export type HarnessCommandSpec = {
  readonly command: string;
  readonly env: Readonly<Record<string, string>>;
  readonly parseTurns: (stdout: string) => number;
  readonly finalMessage: (stdout: string) => string | null;
};

export type HarnessRunnerClock = () => number;

function detectLimit(stdout: string, stderr: string): string | null {
  const text = `${stdout}\n${stderr}`.toLowerCase();
  if (/spend[_ -]?(?:limit|reserved)|budget(?:[_ -]?limit)?/.test(text)) return "spend";
  if (/max[_ -]?turns|turn[_ -]?limit|turns? reached/.test(text)) return "turns";
  if (/context[_ -]?length|context window|too many tokens/.test(text)) return "context";
  if (/rate[_ -]?limit|too many requests/.test(text)) return "rate";
  if (/timeout|timed out/.test(text)) return "time";
  return null;
}

function askedWithoutPatch(message: string | null, patch: SandboxPatch): boolean {
  return patch.patch.trim().length === 0 && Boolean(message?.trim().endsWith("?"));
}

function thrownText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    return [record.error, record.stderr, record.stdout]
      .filter((value): value is string => typeof value === "string")
      .join("\n");
  }
  return "";
}

function isTimeoutError(error: unknown): boolean {
  return /timeout|timed out/i.test(thrownText(error));
}

export async function executeHarnessCommand(
  session: SandboxSession,
  request: HarnessRunRequest,
  spec: HarnessCommandSpec,
  clock: HarnessRunnerClock,
): Promise<HarnessRunOutcome> {
  const startedAt = clock();
  const command: SandboxCommand = {
    command: spec.command,
    cwd: session.workspacePath,
    env: { ...spec.env },
    timeoutMs: request.timeoutMs,
  };

  let execution;
  try {
    execution = await session.exec(command);
  } catch (error) {
    if (!isTimeoutError(error)) throw error;
    const patch = await session.exportPatch();
    const finishedAt = clock();
    return {
      status: "limit-hit",
      limit: "time",
      turnsUsed: 0,
      wallClockSeconds: Math.max(0, finishedAt - startedAt) / 1_000,
      patch,
    };
  }

  const patch = await session.exportPatch();
  const finishedAt = clock();
  const limit = detectLimit(execution.stdout, execution.stderr);

  let status: HarnessRunStatus;
  if (execution.exitCode !== 0) {
    status = limit ? "limit-hit" : "error";
  } else if (askedWithoutPatch(spec.finalMessage(execution.stdout), patch)) {
    status = "asked";
  } else {
    status = "completed";
  }

  return {
    status,
    limit: status === "limit-hit" ? limit : null,
    turnsUsed: Math.max(0, spec.parseTurns(execution.stdout)),
    wallClockSeconds: Math.max(0, finishedAt - startedAt) / 1_000,
    patch,
  };
}

export function jsonLines(stdout: string): ReadonlyArray<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        events.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Harnesses can write non-JSON diagnostics around their JSONL stream.
    }
  }
  return events;
}

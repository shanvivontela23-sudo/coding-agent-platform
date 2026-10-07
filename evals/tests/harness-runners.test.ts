import { describe, expect, it } from "vitest";
import {
  ClaudeCodeHarnessRunner,
  CodexHarnessRunner,
  type HarnessRunRequest,
} from "../src/harness/index.js";
import type {
  SandboxCommand,
  SandboxCommandResult,
  SandboxNetworkPhase,
  SandboxPatch,
  SandboxSession,
  SandboxSnapshot,
} from "../src/sandbox/types.js";

class FakeSession implements SandboxSession {
  readonly id = "sandbox-1";
  readonly workspacePath = "/workspace/repo";
  readonly baselineCommitSha = "a".repeat(40);
  readonly commands: SandboxCommand[] = [];

  constructor(
    private readonly commandResults: SandboxCommandResult[],
    private readonly patch: SandboxPatch,
  ) {}

  async exec(command: SandboxCommand): Promise<SandboxCommandResult> {
    this.commands.push(command);
    return this.commandResults.shift() ?? { exitCode: 0, stdout: "", stderr: "" };
  }

  async readFile(): Promise<string> {
    return "";
  }

  async writeFile(): Promise<void> {}

  async setNetworkPhase(_phase: SandboxNetworkPhase): Promise<void> {}

  async exportPatch(): Promise<SandboxPatch> {
    return this.patch;
  }

  async snapshot(): Promise<SandboxSnapshot> {
    return { id: "snapshot" };
  }

  async destroy(): Promise<void> {}
}

const request: HarnessRunRequest = {
  ticketText: "Fix the support-reported bug without changing unrelated behavior.",
  model: "primary-model",
  gatewayUrl: "https://gateway.example.test",
  runToken: "signed-run-token-must-not-enter-command",
  maxTurns: 12,
  timeoutMs: 60_000,
};

describe("Claude Code harness runner", () => {
  it("records completed status, turns, wall time and the exported patch without putting the token in the command", async () => {
    const session = new FakeSession(
      [
        {
          exitCode: 0,
          stdout: `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Implemented the fix." }] } })}\n${JSON.stringify({ type: "result", subtype: "success", num_turns: 3, result: "Implemented the fix." })}\n`,
          stderr: "",
        },
      ],
      { patch: "diff --git a/src/a.ts b/src/a.ts\n", status: " M src/a.ts\n" },
    );
    let now = 1_000;
    const runner = new ClaudeCodeHarnessRunner({
      version: "2.0.0",
      clock: () => (now += 2_000),
    });

    const outcome = await runner.run(session, request);

    expect(outcome).toMatchObject({
      status: "completed",
      limit: null,
      turnsUsed: 3,
      wallClockSeconds: 2,
      patch: { status: " M src/a.ts\n" },
    });
    expect(session.commands).toHaveLength(1);
    expect(session.commands[0]?.command).toContain("claude");
    expect(session.commands[0]?.command).toContain("--output-format stream-json");
    expect(session.commands[0]?.command).not.toContain(request.runToken);
    expect(session.commands[0]?.command).not.toContain(request.ticketText);
    expect(session.commands[0]?.env).toMatchObject({
      ANTHROPIC_BASE_URL: request.gatewayUrl,
      ANTHROPIC_AUTH_TOKEN: request.runToken,
      BENCHMARK_TICKET: request.ticketText,
    });
  });

  it("records asked when the harness exits successfully with no patch and a question", async () => {
    const session = new FakeSession(
      [
        {
          exitCode: 0,
          stdout: `${JSON.stringify({ type: "result", subtype: "success", num_turns: 2, result: "Which behavior should I preserve?" })}\n`,
          stderr: "",
        },
      ],
      { patch: "", status: "" },
    );
    const runner = new ClaudeCodeHarnessRunner({ version: "2.0.0", clock: () => 0 });

    const outcome = await runner.run(session, request);

    expect(outcome.status).toBe("asked");
    expect(outcome.turnsUsed).toBe(2);
  });

  it("records a spend limit hit instead of a generic error", async () => {
    const session = new FakeSession(
      [{ exitCode: 1, stdout: "", stderr: '{"error":{"code":"spend_limit"}}' }],
      { patch: "", status: "" },
    );
    const runner = new ClaudeCodeHarnessRunner({ version: "2.0.0", clock: () => 0 });

    const outcome = await runner.run(session, request);

    expect(outcome.status).toBe("limit-hit");
    expect(outcome.limit).toBe("spend");
  });
});

describe("Codex harness runner", () => {
  it("uses JSONL exec mode and records turns from turn completion events", async () => {
    const session = new FakeSession(
      [
        {
          exitCode: 0,
          stdout: [
            JSON.stringify({ type: "turn.completed" }),
            JSON.stringify({ type: "turn.completed" }),
            JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Fixed." } }),
          ].join("\n"),
          stderr: "",
        },
      ],
      { patch: "diff --git a/src/a.ts b/src/a.ts\n", status: " M src/a.ts\n" },
    );
    const runner = new CodexHarnessRunner({ version: "0.90.0", clock: () => 0 });

    const outcome = await runner.run(session, request);

    expect(outcome.status).toBe("completed");
    expect(outcome.turnsUsed).toBe(2);
    expect(session.commands[0]?.command).toContain("codex exec");
    expect(session.commands[0]?.command).toContain("--json");
    expect(session.commands[0]?.command).toContain("--full-auto");
    expect(session.commands[0]?.command).not.toContain(request.runToken);
    expect(session.commands[0]?.env).toMatchObject({
      OPENAI_BASE_URL: request.gatewayUrl,
      OPENAI_API_KEY: request.runToken,
      BENCHMARK_TICKET: request.ticketText,
    });
  });

  it("records turn limit hits from structured/CLI output", async () => {
    const session = new FakeSession(
      [{ exitCode: 1, stdout: '{"type":"error","message":"max turns reached"}', stderr: "" }],
      { patch: "", status: "" },
    );
    const runner = new CodexHarnessRunner({ version: "0.90.0", clock: () => 0 });

    const outcome = await runner.run(session, request);

    expect(outcome.status).toBe("limit-hit");
    expect(outcome.limit).toBe("turns");
  });
});

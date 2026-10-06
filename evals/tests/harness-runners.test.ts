import { describe, expect, it } from "vitest";

const harnessModulePath: string = "../src/harness/index.js";

type Command = {
  readonly command: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
};

type CommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
};

type Outcome = {
  readonly status: "completed" | "asked" | "limit-hit" | "error";
  readonly limit: string | null;
  readonly turnsUsed: number;
  readonly wallClockSeconds: number;
};

type RunnerRequest = {
  readonly ticketText: string;
  readonly model: string;
  readonly gatewayUrl: string;
  readonly runToken: string;
  readonly timeoutMs: number;
  readonly maxTurns?: number;
};

type Runner = {
  readonly name: string;
  readonly version: string;
  run(session: unknown, request: RunnerRequest): Promise<Outcome>;
};

type HarnessModule = {
  ClaudeCodeHarnessRunner: new (options: {
    expectedVersion: string;
    clock?: () => number;
  }) => Runner;
  CodexHarnessRunner: new (options: {
    expectedVersion: string;
    clock?: () => number;
  }) => Runner;
  executeHarnessTask: (options: Record<string, unknown>) => Promise<{
    outcome: Outcome;
    patch: { patch: string; status: string };
    sandboxId: string;
  }>;
};

async function loadHarness(): Promise<HarnessModule> {
  return (await import(/* @vite-ignore */ harnessModulePath)) as HarnessModule;
}

function clockSequence(...values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
}

class FakeSession {
  readonly id = "harness-sandbox";
  readonly workspacePath = "/workspace/repo";
  readonly baselineCommitSha = "b".repeat(40);
  readonly commands: Command[] = [];
  readonly writes: Array<{ path: string; data: string | ArrayBuffer }> = [];
  readonly phases: string[] = [];
  readonly reads = new Map<string, string>();
  readonly responses: CommandResult[] = [];
  versionResult: CommandResult = { exitCode: 0, stdout: "", stderr: "" };
  destroyed = 0;

  async exec(command: Command): Promise<CommandResult> {
    this.commands.push(command);
    if (command.command.includes("--version")) return this.versionResult;
    return this.responses.shift() ?? { exitCode: 0, stdout: "", stderr: "" };
  }

  async readFile(path: string): Promise<string> {
    return this.reads.get(path) ?? "";
  }

  async writeFile(path: string, data: string | ArrayBuffer): Promise<void> {
    this.writes.push({ path, data });
  }

  async setNetworkPhase(phase: string): Promise<void> {
    this.phases.push(phase);
  }

  async exportPatch() {
    return { patch: "diff --git a/src/a.ts b/src/a.ts\n", status: " M src/a.ts\n" };
  }

  async snapshot() {
    return { id: "snapshot" };
  }

  async destroy(): Promise<void> {
    this.destroyed += 1;
  }
}

const request: RunnerRequest = {
  ticketText: "Fix the support ticket without changing dependencies.",
  model: "benchmark-model",
  gatewayUrl: "https://gateway.example.com",
  runToken: "short-lived-run-token",
  timeoutMs: 60_000,
  maxTurns: 5,
};

describe("Claude Code harness adapter", () => {
  it("runs the exact pinned binary non-interactively and records completed metadata", async () => {
    const { ClaudeCodeHarnessRunner } = await loadHarness();
    const session = new FakeSession();
    session.versionResult = {
      exitCode: 0,
      stdout: "2.1.300 (Claude Code)\n",
      stderr: "",
    };
    session.responses.push({
      exitCode: 0,
      stdout: JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: 4,
        structured_output: { status: "completed", question: null },
      }),
      stderr: "",
    });
    const runner = new ClaudeCodeHarnessRunner({
      expectedVersion: "2.1.300",
      clock: clockSequence(1_000, 4_000),
    });

    await expect(runner.run(session, request)).resolves.toEqual({
      status: "completed",
      limit: null,
      turnsUsed: 4,
      wallClockSeconds: 3,
    });

    expect(runner.name).toBe("claude-code");
    expect(runner.version).toBe("2.1.300");
    const command = session.commands.at(-1)!;
    expect(command.command).toContain("claude -p");
    expect(command.command).toContain("--output-format json");
    expect(command.command).toContain("--json-schema");
    expect(command.command).toContain("--max-turns 5");
    expect(command.command).toContain("--permission-mode bypassPermissions");
    expect(command.command).toContain("--model");
    expect(command.command).not.toContain(request.ticketText);
    expect(command.env).toMatchObject({
      ANTHROPIC_BASE_URL: request.gatewayUrl,
      ANTHROPIC_AUTH_TOKEN: request.runToken,
    });
    expect(session.writes.some(({ data }) => String(data).includes(request.ticketText))).toBe(true);
  });

  it("records asked when the structured terminal result asks for information", async () => {
    const { ClaudeCodeHarnessRunner } = await loadHarness();
    const session = new FakeSession();
    session.versionResult = { exitCode: 0, stdout: "2.1.300\n", stderr: "" };
    session.responses.push({
      exitCode: 0,
      stdout: JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: 2,
        structured_output: { status: "asked", question: "Which behavior is intended?" },
      }),
      stderr: "",
    });
    const runner = new ClaudeCodeHarnessRunner({ expectedVersion: "2.1.300" });

    const outcome = await runner.run(session, request);
    expect(outcome.status).toBe("asked");
    expect(outcome.limit).toBeNull();
    expect(outcome.turnsUsed).toBe(2);
  });

  it("records the turns limit when Claude exits at max turns", async () => {
    const { ClaudeCodeHarnessRunner } = await loadHarness();
    const session = new FakeSession();
    session.versionResult = { exitCode: 0, stdout: "2.1.300\n", stderr: "" };
    session.responses.push({
      exitCode: 1,
      stdout: JSON.stringify({
        type: "result",
        subtype: "error_max_turns",
        is_error: true,
        num_turns: 5,
      }),
      stderr: "max turns reached",
    });
    const runner = new ClaudeCodeHarnessRunner({ expectedVersion: "2.1.300" });

    await expect(runner.run(session, request)).resolves.toMatchObject({
      status: "limit-hit",
      limit: "turns",
      turnsUsed: 5,
    });
  });
});

describe("Codex harness adapter", () => {
  it("uses codex exec JSON events and records native turns", async () => {
    const { CodexHarnessRunner } = await loadHarness();
    const session = new FakeSession();
    session.versionResult = { exitCode: 0, stdout: "codex-cli 0.145.0\n", stderr: "" };
    session.responses.push({
      exitCode: 0,
      stdout: [
        JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
        JSON.stringify({ type: "turn.started" }),
        JSON.stringify({ type: "turn.completed", usage: {} }),
      ].join("\n"),
      stderr: "",
    });
    session.reads.set(
      ".coding-agent/harness-result.json",
      JSON.stringify({ status: "completed", question: null }),
    );
    const runner = new CodexHarnessRunner({
      expectedVersion: "0.145.0",
      clock: clockSequence(2_000, 7_000),
    });

    await expect(runner.run(session, request)).resolves.toEqual({
      status: "completed",
      limit: null,
      turnsUsed: 1,
      wallClockSeconds: 5,
    });

    const command = session.commands.at(-1)!;
    expect(command.command).toContain("codex exec");
    expect(command.command).toContain("--json");
    expect(command.command).toContain("--sandbox workspace-write");
    expect(command.command).toContain("--ask-for-approval never");
    expect(command.command).toContain("--output-schema");
    expect(command.command).toContain("--output-last-message");
    expect(command.command).toContain("openai_base_url");
    expect(command.command).not.toContain(request.ticketText);
    expect(command.env).toMatchObject({
      OPENAI_API_KEY: request.runToken,
    });
  });

  it("records wall-clock limit hits from the command timeout", async () => {
    const { CodexHarnessRunner } = await loadHarness();
    const session = new FakeSession();
    session.versionResult = { exitCode: 0, stdout: "codex-cli 0.145.0\n", stderr: "" };
    session.responses.push({ exitCode: 124, stdout: "", stderr: "" });
    const runner = new CodexHarnessRunner({ expectedVersion: "0.145.0" });

    await expect(runner.run(session, request)).resolves.toMatchObject({
      status: "limit-hit",
      limit: "wall-clock",
      turnsUsed: 0,
    });
  });
});

describe("harness task execution", () => {
  it("installs dependencies before coding, exports the patch, and always destroys the first sandbox", async () => {
    const { executeHarnessTask } = await loadHarness();
    const session = new FakeSession();
    const createCalls: unknown[] = [];
    const provider = {
      create: async (value: unknown) => {
        createCalls.push(value);
        return session;
      },
    };
    const runner: Runner = {
      name: "synthetic",
      version: "1.0.0",
      run: async () => ({
        status: "completed",
        limit: null,
        turnsUsed: 3,
        wallClockSeconds: 2,
      }),
    };

    const result = await executeHarnessTask({
      sandboxProvider: provider,
      runner,
      taskId: "task-1",
      repository: {
        pinnedCommit: "a".repeat(40),
        archiveSha256: "b".repeat(64),
        archive: new Uint8Array(),
      },
      gatewayUrl: "https://gateway.example.com",
      ticketText: "synthetic ticket",
      model: "model-1",
      runToken: "run-token",
      dependencyInstallCommand: "pnpm install --frozen-lockfile",
      timeoutMs: 60_000,
      maxTurns: 5,
    });

    expect(createCalls).toHaveLength(1);
    expect(session.phases).toEqual(["dependency-setup", "coding"]);
    expect(session.commands.some(({ command }) => command === "pnpm install --frozen-lockfile")).toBe(true);
    expect(result.sandboxId).toBe("harness-sandbox");
    expect(result.patch.patch).toContain("diff --git");
    expect(result.outcome.status).toBe("completed");
    expect(session.destroyed).toBe(1);
  });
});

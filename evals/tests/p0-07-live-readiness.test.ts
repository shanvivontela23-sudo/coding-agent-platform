import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  ClaudeCodeHarnessRunner,
  CodexHarnessRunner,
  type HarnessRunRequest,
  type HarnessRunner,
} from "../src/harness/index.js";
import { buildPhase0HarnessTicket, PHASE0_INSTRUCTION_VERSION } from "../src/orchestrator/instruction.js";
import { loadPhase0LiveConfig } from "../src/orchestrator/live-config.js";
import { Phase0RunOrchestrator } from "../src/orchestrator/phase0-run.js";
import type {
  SandboxCommand,
  SandboxCommandResult,
  SandboxCreateRequest,
  SandboxPatch,
  SandboxProvider,
  SandboxSession,
  SandboxSnapshot,
} from "../src/sandbox/types.js";
import { typescriptNodeHarnessTemplate } from "../sandbox-templates/typescript-node/template.js";

class FakeSession implements SandboxSession {
  readonly id = "sandbox-live";
  readonly workspacePath = "/workspace/repo";
  readonly baselineCommitSha = "a".repeat(40);
  readonly commands: SandboxCommand[] = [];
  exportCount = 0;

  constructor(
    private readonly execute: (command: SandboxCommand) => Promise<SandboxCommandResult>,
    private readonly patch: SandboxPatch,
  ) {}

  async exec(command: SandboxCommand): Promise<SandboxCommandResult> {
    this.commands.push(command);
    return await this.execute(command);
  }
  async readFile(): Promise<string> { return ""; }
  async writeFile(): Promise<void> {}
  async setNetworkPhase(): Promise<void> {}
  async exportPatch(): Promise<SandboxPatch> { this.exportCount += 1; return this.patch; }
  async snapshot(): Promise<SandboxSnapshot> { return { id: "snapshot" }; }
  async destroy(): Promise<void> {}
}

const request: HarnessRunRequest = {
  ticketText: "Customer cannot save an edited profile.",
  model: "primary-model",
  gatewayUrl: "https://gateway.example.test/v1",
  runToken: "signed-token",
  maxTurns: 12,
  timeoutMs: 60_000,
};

describe("P0-07 live readiness", () => {
  it("exports a partial patch and records time limit when the harness command times out", async () => {
    const session = new FakeSession(
      async () => { throw new Error("command timed out after 60000ms"); },
      { patch: "diff --git a/src/a.ts b/src/a.ts\n", status: " M src/a.ts\n" },
    );
    const runner = new ClaudeCodeHarnessRunner({ version: "2.0.0", clock: () => 0 });

    const outcome = await runner.run(session, request);

    expect(outcome).toMatchObject({ status: "limit-hit", limit: "time" });
    expect(outcome.patch.patch).toContain("src/a.ts");
    expect(session.exportCount).toBe(1);
  });

  it("loads a required configurable E2B template id and keeps pinned harness versions in a loadable template definition", async () => {
    expect(loadPhase0LiveConfig({ E2B_TEMPLATE_ID: "coding-agent-ts-node-v1" })).toEqual({
      e2bTemplateId: "coding-agent-ts-node-v1",
    });
    expect(() => loadPhase0LiveConfig({})).toThrow("E2B_TEMPLATE_ID");

    const template = await readFile("evals/sandbox-templates/typescript-node/template.ts", "utf8");
    expect(template).toContain("@anthropic-ai/claude-code@2.0.0");
    expect(template).toContain("@openai/codex@0.90.0");
    expect(typescriptNodeHarnessTemplate).toBeDefined();
  });

  it("prepends the versioned fixed Phase 0 instruction to every ticket", () => {
    const combined = buildPhase0HarnessTicket("Customer sees a duplicate invoice.");
    expect(PHASE0_INSTRUCTION_VERSION).toBe("phase0-bugfix-v1");
    expect(combined).toContain("Read the ticket and find the cause");
    expect(combined).toContain("write a test that fails because of the bug");
    expect(combined).toContain("smallest change that fits the repository's style");
    expect(combined.indexOf("Read the ticket")).toBeLessThan(combined.indexOf("Customer sees a duplicate invoice."));
  });

  it("uses the configured template id and prepends the fixed instruction in the live orchestrator", async () => {
    const session = new FakeSession(
      async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      { patch: "diff --git a/src/a.ts b/src/a.ts\n", status: " M src/a.ts\n" },
    );
    const createRequests: SandboxCreateRequest[] = [];
    const provider: SandboxProvider = {
      create: async (createRequest) => {
        createRequests.push(createRequest);
        return session;
      },
    };
    const seenTickets: string[] = [];
    const harness: HarnessRunner = {
      name: "codex",
      version: "0.90.0",
      run: async (_session, harnessRequest) => {
        seenTickets.push(harnessRequest.ticketText);
        return {
          status: "completed",
          limit: null,
          turnsUsed: 1,
          wallClockSeconds: 1,
          patch: { patch: "diff --git a/src/a.ts b/src/a.ts\n", status: " M src/a.ts\n" },
        };
      },
    };
    const orchestrator = new Phase0RunOrchestrator({
      sandboxProvider: provider,
      liveConfig: { e2bTemplateId: "coding-agent-ts-node-v1" },
    });

    await orchestrator.run({
      taskId: "task-1",
      repository: {
        pinnedCommit: "a".repeat(40),
        archiveSha256: "b".repeat(64),
        archive: new TextEncoder().encode("archive"),
      },
      gatewayUrl: request.gatewayUrl,
      runToken: request.runToken,
      ticketText: "Customer sees a duplicate invoice.",
      model: request.model,
      maxTurns: request.maxTurns,
      timeoutMs: request.timeoutMs,
      harness,
    });

    expect(createRequests[0]?.template).toBe("coding-agent-ts-node-v1");
    expect(seenTickets[0]).toContain("Read the ticket and find the cause");
    expect(seenTickets[0]?.endsWith("Customer sees a duplicate invoice.")).toBe(true);
  });

  it("configures Codex with the approved custom Responses provider and no websocket transport", async () => {
    const session = new FakeSession(
      async () => ({ exitCode: 0, stdout: '{"type":"turn.completed"}\n', stderr: "" }),
      { patch: "diff --git a/src/a.ts b/src/a.ts\n", status: " M src/a.ts\n" },
    );
    const runner = new CodexHarnessRunner({ version: "0.90.0", clock: () => 0 });

    await runner.run(session, request);

    const command = session.commands[0]?.command ?? "";
    expect(command).toContain("model_provider=\"benchmark_gateway\"");
    expect(command).toContain("model_providers.benchmark_gateway.base_url");
    expect(command).toContain("wire_api=\"responses\"");
    expect(command).toContain("responses_websockets=false");
  });
});

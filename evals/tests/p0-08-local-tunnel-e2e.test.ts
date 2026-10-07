import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  assertIncrementalAnthropicStream,
  gatewayUrlFromHostname,
} from "../smoke/local-tunnel.js";
import { sandboxLifetimeMs } from "../src/orchestrator/sandbox-lifetime.js";
import {
  ClaudeCodeHarnessRunner,
  type HarnessRunRequest,
} from "../src/harness/index.js";
import type {
  SandboxCommandResult,
  SandboxPatch,
  SandboxSession,
  SandboxSnapshot,
} from "../src/sandbox/types.js";

class TimeoutSession implements SandboxSession {
  readonly id = "timeout";
  readonly workspacePath = "/workspace/repo";
  readonly baselineCommitSha = "a".repeat(40);
  exports = 0;
  async exec(): Promise<SandboxCommandResult> {
    throw new Error("command timed out after 60000ms");
  }
  async readFile(): Promise<string> { return ""; }
  async writeFile(): Promise<void> {}
  async setNetworkPhase(): Promise<void> {}
  async exportPatch(): Promise<SandboxPatch> {
    this.exports += 1;
    return { patch: "diff --git a/src/a.ts b/src/a.ts\n", status: " M src/a.ts\n" };
  }
  async snapshot(): Promise<SandboxSnapshot> { return { id: "snapshot" }; }
  async destroy(): Promise<void> {}
}

const harnessRequest: HarnessRunRequest = {
  ticketText: "Fix the bug.",
  model: "anthropic/model",
  gatewayUrl: "https://gateway.example.test",
  runToken: "signed-token",
  maxTurns: 12,
  timeoutMs: 60_000,
};

describe("P0-08 local tunnel profile", () => {
  it("defines a Mac-local Compose profile with no Caddy and Anthropic-only provider credentials", async () => {
    const compose = await readFile("evals/deploy/http-gateway/compose.local.yaml", "utf8");
    expect(compose).toContain('"127.0.0.1:8080:8080"');
    expect(compose).toContain('"127.0.0.1:4000:4000"');
    expect(compose).not.toMatch(/caddy:/i);
    expect(compose).toContain("ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:?ANTHROPIC_API_KEY is required}");
    expect(compose).toContain('OPENAI_API_KEY: ""');
    expect(compose).toContain("GATEWAY_HOSTNAME: ${GATEWAY_HOSTNAME:?GATEWAY_HOSTNAME is required}");
  });

  it("accepts a hostname only and derives the public HTTPS gateway URL", () => {
    expect(gatewayUrlFromHostname("phase0.example-tunnel.com")).toBe("https://phase0.example-tunnel.com");
    expect(() => gatewayUrlFromHostname("https://phase0.example-tunnel.com")).toThrow("hostname only");
    expect(() => gatewayUrlFromHostname("phase0.example-tunnel.com/path")).toThrow("hostname only");
  });

  it("proves at least two Anthropic stream chunks arrive at distinct read times before message_stop", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("event: content_block_delta\ndata: {\"delta\":{\"text\":\"one\"}}\n\n"));
        setTimeout(() => controller.enqueue(encoder.encode("event: content_block_delta\ndata: {\"delta\":{\"text\":\"two\"}}\n\n")), 5);
        setTimeout(() => {
          controller.enqueue(encoder.encode("event: message_stop\ndata: {}\n\n"));
          controller.close();
        }, 10);
      },
    });
    const response = new Response(stream, { status: 200 });
    const evidence = await assertIncrementalAnthropicStream(response, () => performance.now());
    expect(evidence.dataChunks).toBeGreaterThanOrEqual(2);
    expect(evidence.secondChunkAtMs).toBeGreaterThan(evidence.firstChunkAtMs);
    expect(evidence.terminalAtMs).toBeGreaterThanOrEqual(evidence.secondChunkAtMs);
  });

  it("pins current harness versions and the template base image by full digest", async () => {
    const template = await readFile("evals/sandbox-templates/typescript-node/template.ts", "utf8");
    expect(template).toContain('@anthropic-ai/claude-code@2.1.292');
    expect(template).toContain('@openai/codex@0.160.1');
    expect(template).toContain('node:22-bookworm@sha256:1caeacc40090c4607170d7508b4eb8d5575a681a1b3a02b9cd65e878fa2d4779');
  });

  it("sets sandbox lifetime to setup + run + five-minute margin", () => {
    expect(sandboxLifetimeMs({ setupTimeoutMs: 120_000, runTimeoutMs: 600_000 })).toBe(1_020_000);
  });

  it("still exports a partial patch when the run hits its wall-clock timeout", async () => {
    const session = new TimeoutSession();
    const outcome = await new ClaudeCodeHarnessRunner({ version: "2.1.292", clock: () => 0 }).run(session, harnessRequest);
    expect(outcome).toMatchObject({ status: "limit-hit", limit: "time" });
    expect(outcome.patch.patch).toContain("src/a.ts");
    expect(session.exports).toBe(1);
  });

  it("documents the Codex 0.160.1 turn-limit qualification as wall-clock-only", async () => {
    const note = await readFile("evals/docs/phase-0/live-readiness.md", "utf8");
    expect(note).toContain("Codex CLI `0.160.1`");
    expect(note).toMatch(/not[^\n]*expose[^\n]*hard max-turns/i);
    expect(note).toMatch(/wall-clock|command timeout/i);
  });

  it("exposes operator-only paid commands for local preflight and one-task Claude end to end", async () => {
    const pkg = JSON.parse(await readFile("package.json", "utf8")) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.["smoke:local-tunnel"]).toBe("tsx evals/smoke/local-tunnel-preflight.ts");
    expect(pkg.scripts?.["eval:run:claude-one"]).toBe("tsx evals/src/operator/single-claude-task-cli.ts");
    const preflight = await readFile("evals/smoke/local-tunnel-preflight.ts", "utf8");
    const command = await readFile("evals/src/operator/single-claude-task-cli.ts", "utf8");
    for (const source of [preflight, command]) {
      expect(source).toContain("requireLiveSmoke");
      expect(source).toMatch(/Estimated.*spend/i);
      expect(source).toMatch(/Actual.*spend/i);
    }
    const start = command.indexOf("startLocalHttpRun(");
    const harness = command.indexOf("orchestrator.run(");
    const collect = command.indexOf("collector.collect(");
    const reconcile = command.indexOf("finishAndReconcileLocalRun(");
    const write = command.indexOf("FileRunResultWriter(resultRoot).write(");
    expect(start).toBeGreaterThan(-1);
    expect(harness).toBeGreaterThan(start);
    expect(collect).toBeGreaterThan(harness);
    expect(reconcile).toBeGreaterThan(collect);
    expect(write).toBeGreaterThan(reconcile);
  });
});

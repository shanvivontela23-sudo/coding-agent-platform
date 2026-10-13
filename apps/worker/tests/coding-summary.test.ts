import { describe, expect, it } from "vitest";
import { executeHarnessCommand } from "../../../evals/src/harness/common.js";
import { codingSummary } from "../src/product-coding-runner.js";

// Live run 2026-10-13: "What changed and why" only said "codex completed in 1 turns".
describe("coding summary for the change note", () => {
  it("uses the agent's final message", () => {
    expect(codingSummary("Multiplied the refund by the returned quantity and added regression tests.", "codex", 1))
      .toBe("Multiplied the refund by the returned quantity and added regression tests.");
  });

  it("falls back to a grammatical turn count when there is no message", () => {
    expect(codingSummary(undefined, "codex", 1)).toBe("codex completed in 1 turn.");
    expect(codingSummary("   ", "codex", 3)).toBe("codex completed in 3 turns.");
  });

  it("bounds very long messages", () => {
    const summary = codingSummary("x".repeat(5_000), "codex", 1);
    expect(summary.length).toBeLessThanOrEqual(2_001);
    expect(summary.endsWith("…")).toBe(true);
  });

  it("harness outcome carries the final message", async () => {
    const session = {
      workspacePath: "/workspace/repo",
      exec: async () => ({ exitCode: 0, stdout: "events", stderr: "" }),
      exportPatch: async () => ({ patch: "diff --git a/x b/x\n", files: ["x"] }),
    } as never;
    const outcome = await executeHarnessCommand(session, { timeoutMs: 1_000 } as never, {
      command: "true",
      env: {},
      parseTurns: () => 1,
      finalMessage: () => "  Fixed the refund total.  ",
    }, () => 0);
    expect(outcome.finalMessage).toBe("Fixed the refund total.");
  });
});

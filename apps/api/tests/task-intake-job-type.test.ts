import { describe, expect, it } from "vitest";
import { buildClarificationPrompt, buildPlanPrompt, normalizeJobType, TaskPlanner, taskJobTypes, type TaskModelGateway } from "../src/task-intake.js";

describe("task job type", () => {
  it("tells the model the exact allowed values and when to use bug_fix", () => {
    const system = buildClarificationPrompt({ maskedTicket: "t", repositoryContext: "c" })[0]!.content;
    expect(system).toContain(`jobType must be exactly one of: ${taskJobTypes.join(", ")}`);
    expect(system).toContain("Use bug_fix whenever the ticket reports existing behavior that is wrong");
    // Live run: a suggested answer named calculateRefund and item.unitPrice.
    expect(system).toContain("Each suggestedAnswer must also describe customer-visible behavior only");
  });

  it.each([
    ["bug_fix", "bug_fix"],
    ["Bug Fix", "bug_fix"],
    ["bugfix", "bug_fix"],
    ["fix-refund-bug", "bug_fix"],
    ["regression", "bug_fix"],
    ["feature", "feature"],
    ["new_feature", "feature"],
    ["clarify-behavior-change", "change"],
    ["", "other"],
    [42, "other"],
    ["something else", "other"],
  ])("normalizes %j to %s", (input, expected) => {
    expect(normalizeJobType(input)).toBe(expected);
  });

  it("stores a normalized job type from clarify", async () => {
    const gateway: TaskModelGateway = {
      startTaskRun: async () => undefined,
      call: async () => ({ jobType: "Bug Fix", questions: [] }),
      finishTaskRun: async () => undefined,
    } as unknown as TaskModelGateway;
    const result = await new TaskPlanner({ gateway, spendCapUsd: 1 }).clarify({ taskId: "t", maskedTicket: "m", repositoryContext: "c" });
    expect(result.jobType).toBe("bug_fix");
  });
});

describe("plan wording for support reps", () => {
  it("forbids code in proposedApproach but keeps backticked file names usable for publication", () => {
    const system = buildPlanPrompt({ maskedTicket: "t", repositoryContext: "c", answers: [] })[0]!.content;
    expect(system).toContain("never include code, code lines, snippets, expressions, or function names");
    expect(system).toContain("You may name affected files in backticks");
  });
});

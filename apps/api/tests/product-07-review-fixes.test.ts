import { describe, expect, it } from "vitest";
import { TaskPlanner, type PromptMessage, type TaskModelGateway } from "../src/task-intake.js";

class RecordedGateway implements TaskModelGateway {
  readonly calls: Array<{ purpose: string; messages: readonly PromptMessage[] }> = [];
  private readonly responses: unknown[];
  constructor(responses: unknown[]) { this.responses = [...responses]; }
  async startTaskRun(): Promise<void> {}
  async call(_taskId: string, purpose: string, messages: readonly PromptMessage[]): Promise<unknown> {
    this.calls.push({ purpose, messages });
    const response = this.responses.shift();
    if (response === undefined) throw new Error("missing recorded response");
    return response;
  }
  async finishTaskRun(): Promise<void> {}
}

describe("Product 07 task-intake review fixes", () => {
  it("keeps ordinary behavior questions containing file and table unchanged", async () => {
    const gateway = new RecordedGateway([{
      jobType: "feature",
      questions: [
        { question: "When the customer uploads a file, should the previous attachment remain visible?", suggestedAnswer: "Yes, keep it visible until the upload succeeds." },
        { question: "Should the table show cancelled orders?", suggestedAnswer: "Yes, show them with a Cancelled status." },
      ],
    }]);
    const planner = new TaskPlanner({ gateway, spendCapUsd: 0.5 });
    const result = await planner.clarify({ taskId: "task-safe", maskedTicket: "change upload behavior", repositoryContext: "context" });
    expect(result.questions.map((question) => question.question)).toEqual([
      "When the customer uploads a file, should the previous attachment remain visible?",
      "Should the table show cancelled orders?",
    ]);
    expect(result.questionFilterStats).toEqual({ filteredCount: 0, rephrasedCount: 0 });
    expect(gateway.calls).toHaveLength(1);
  });

  it("makes one behavior-only rephrase call for a technical question and records the outcome", async () => {
    const gateway = new RecordedGateway([
      { jobType: "bug_fix", questions: [{ question: "Which React component should call the endpoint?", suggestedAnswer: "Update the checkout component." }] },
      { question: "What should the customer see after checkout fails?", suggestedAnswer: "Keep the cart visible and offer retry." },
    ]);
    const planner = new TaskPlanner({ gateway, spendCapUsd: 0.5 });
    const result = await planner.clarify({ taskId: "task-rephrase", maskedTicket: "checkout fails", repositoryContext: "context" });
    expect(result.questions).toEqual([{ question: "What should the customer see after checkout fails?", suggestedAnswer: "Keep the cart visible and offer retry." }]);
    expect(result.questionFilterStats).toEqual({ filteredCount: 1, rephrasedCount: 1 });
    expect(gateway.calls.map((call) => call.purpose)).toEqual(["clarify", "rephrase-question-1"]);
    expect(gateway.calls[1]?.messages[0]?.content).not.toContain("Which React component");
    expect(gateway.calls[1]?.messages[1]?.content).toContain("<UNTRUSTED_QUESTION>");
  });

  it("drops a question only when the single rephrase still contains implementation terms", async () => {
    const gateway = new RecordedGateway([
      { jobType: "bug_fix", questions: [{ question: "Which function should change?", suggestedAnswer: "Change save()." }] },
      { question: "Which JavaScript function should change?", suggestedAnswer: "Change save()." },
    ]);
    const planner = new TaskPlanner({ gateway, spendCapUsd: 0.5 });
    const result = await planner.clarify({ taskId: "task-drop", maskedTicket: "save fails", repositoryContext: "context" });
    expect(result.questions).toEqual([]);
    expect(result.questionFilterStats).toEqual({ filteredCount: 1, rephrasedCount: 0 });
    expect(gateway.calls).toHaveLength(2);
  });

  it("ignores model-provided cost/time and derives labelled estimate ranges only from job size", async () => {
    const gateway = new RecordedGateway([{
      whatIUnderstand: "The customer can retry a failed save.",
      proposedApproach: "Keep the entered values and expose a retry action.",
      size: "medium",
      estimate: { costUsd: 9999, timeMinutes: 1 },
    }]);
    const planner = new TaskPlanner({ gateway, spendCapUsd: 0.5 });
    const result = await planner.plan({ taskId: "task-estimate", maskedTicket: "retry failed saves", repositoryContext: "context", answers: [] });
    expect(result.estimate).toEqual({ label: "estimate", costUsdMin: 0.3, costUsdMax: 1.5, timeMinutesMin: 30, timeMinutesMax: 90 });
    expect(gateway.calls[0]?.messages[0]?.content).toContain("Return JSON only with whatIUnderstand, proposedApproach, and size");
    expect(gateway.calls[0]?.messages[0]?.content).not.toContain("costUsd");
    expect(gateway.calls[0]?.messages[0]?.content).not.toContain("timeMinutes");
  });
});

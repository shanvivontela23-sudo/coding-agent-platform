import { describe, expect, it } from "vitest";
import {
  buildClarificationPrompt,
  buildPlanPrompt,
  maskPersonalData,
  TaskPlanner,
  type TaskModelGateway,
} from "../src/task-intake.js";

const recordedClarification = {
  jobType: "bug_fix",
  questions: [
    { question: "Should the customer be able to retry after the error?", suggestedAnswer: "Yes, allow a retry." },
    { question: "Should the previous value remain visible when saving fails?", suggestedAnswer: "Yes, keep the previous value." },
  ],
};

const recordedPlan = {
  whatIUnderstand: "When saving fails, keep the previous value visible and allow the customer to retry.",
  proposedApproach: "Preserve the previous value, show a clear failure state, and let the customer try again without losing their input.",
  size: "small",
};

class RecordedGateway implements TaskModelGateway {
  readonly starts: Array<{ taskId: string; spendCapUsd: number }> = [];
  readonly calls: Array<{ taskId: string; purpose: string; messages: readonly { role: string; content: string }[] }> = [];
  private readonly responses: unknown[];

  constructor(responses: unknown[]) { this.responses = [...responses]; }

  async startTaskRun(taskId: string, spendCapUsd: number): Promise<void> {
    this.starts.push({ taskId, spendCapUsd });
  }

  async call(taskId: string, purpose: string, messages: readonly { role: "system" | "user"; content: string }[]): Promise<unknown> {
    this.calls.push({ taskId, purpose, messages });
    const response = this.responses.shift();
    if (response === undefined) throw new Error("missing recorded response");
    return response;
  }

  async finishTaskRun(): Promise<void> {}
}

describe("task intake privacy and prompt boundaries", () => {
  it("masks personal data before model input while leaving ordinary product text readable", () => {
    const masked = maskPersonalData("Customer John Smith (john.smith@example.com, +1 (408) 555-1212) says account 998877665544 cannot save the cart.");
    expect(masked).not.toContain("John Smith");
    expect(masked).not.toContain("john.smith@example.com");
    expect(masked).not.toContain("408");
    expect(masked).not.toContain("998877665544");
    expect(masked).toContain("cannot save the cart");
    expect(masked).toContain("[MASKED_NAME]");
    expect(masked).toContain("[MASKED_EMAIL]");
    expect(masked).toContain("[MASKED_PHONE]");
    expect(masked).toContain("account [MASKED_ACCOUNT]");
  });

  it("keeps ticket, repository context and prior model output out of the system role", () => {
    const clarification = buildClarificationPrompt({ maskedTicket: "ticket-secret", repositoryContext: "repo-secret" });
    expect(clarification[0]?.role).toBe("system");
    expect(clarification[0]?.content).not.toContain("ticket-secret");
    expect(clarification[0]?.content).not.toContain("repo-secret");
    expect(clarification[1]?.role).toBe("user");
    expect(clarification[1]?.content).toContain("<UNTRUSTED_TICKET>");
    expect(clarification[1]?.content).toContain("<UNTRUSTED_REPOSITORY_CONTEXT>");

    const plan = buildPlanPrompt({ maskedTicket: "ticket-secret", repositoryContext: "repo-secret", answers: [{ question: "q", answer: "model-or-user-output" }] });
    expect(plan[0]?.content).not.toContain("model-or-user-output");
    expect(plan[0]?.content).not.toContain("costUsd");
    expect(plan[0]?.content).not.toContain("timeMinutes");
    expect(plan[1]?.content).toContain("<UNTRUSTED_ANSWERS>");
  });
});

describe("task planning pipeline", () => {
  it("uses a per-task gateway budget, recorded responses, and behavior-only questions capped at five", async () => {
    const gateway = new RecordedGateway([{ jobType: "feature", questions: [
      ...recordedClarification.questions,
      { question: "What should happen if the request arrives twice?", suggestedAnswer: "Treat the second request as a retry." },
      { question: "Should the user see that the request is still being processed?", suggestedAnswer: "Yes." },
      { question: "Should a failed attempt be safe to try again?", suggestedAnswer: "Yes." },
      { question: "Sixth question must be discarded", suggestedAnswer: "Discard me" },
    ] }]);
    const planner = new TaskPlanner({ gateway, spendCapUsd: 0.5 });
    const result = await planner.clarify({ taskId: "task-1", maskedTicket: "Fix retry behavior", repositoryContext: "src/app.ts: retry text" });

    expect(gateway.starts).toEqual([{ taskId: "task-1", spendCapUsd: 0.5 }]);
    expect(result.questions).toHaveLength(5);
    expect(result.questions.map((question) => question.question).join(" ")).not.toMatch(/\b(function|framework|react|typescript|javascript|python|repository|endpoint|commit|sql)\b/i);
    expect(result.questionFilterStats).toEqual({ filteredCount: 0, rephrasedCount: 0 });
    expect(gateway.calls).toHaveLength(1);
    expect(gateway.calls[0]?.messages[0]?.content).not.toContain("Fix retry behavior");
  });

  it("produces a plain-language plan plus server-derived estimate range after answers", async () => {
    const gateway = new RecordedGateway([recordedPlan]);
    const planner = new TaskPlanner({ gateway, spendCapUsd: 0.5 });
    const result = await planner.plan({
      taskId: "task-2",
      maskedTicket: "Saving can fail",
      repositoryContext: "Relevant behavior summary",
      answers: recordedClarification.questions.map((item) => ({ question: item.question, answer: item.suggestedAnswer })),
    });

    expect(result).toEqual({ ...recordedPlan, estimate: { label: "estimate", costUsdMin: 0.05, costUsdMax: 0.3, timeMinutesMin: 10, timeMinutesMax: 30 } });
    expect(result.size).toBe("small");
    expect(gateway.calls[0]?.purpose).toBe("plan");
  });
});

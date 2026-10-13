import { describe, expect, it } from "vitest";
import { containsCode, TaskPlanner, type TaskModelGateway } from "../src/task-intake.js";

describe("containsCode", () => {
  it.each([
    // Exact strings from the 2026-10-13 live runs.
    "Fix the calculateRefund function in src/refund.js to multiply each item's unitPrice by the returned quantity. The line 'total += item.unitPrice;' should become 'total += item.unitPrice * returned.quantity;'.",
    "Yes, the bug is in the calculateRefund function which adds item.unitPrice once per returned item instead of multiplying by the returned quantity.",
    "In the `src/refund.js` file, modify the calculateRefund function to multiply the unit price by the returned quantity.",
    "Call `refund()` from the screen.",
    "Use refund(order) here.",
    "Return early when x === null",
    "Update refund.js so it uses item.unitPrice for each unit",
  ])("flags code: %s", (text) => {
    expect(containsCode(text)).toBe(true);
  });

  it.each([
    "In the `src/refund.js` file, multiply the unit price by the number of units returned.",
    "Yes, if a customer returns 2 mugs at $2.49 each, the refund should be $4.98 (2 × $2.49), not $2.49.",
    "Shipping should only be refunded when every unit of every item is returned, e.g. a full order return.",
    "Update refund.js and the tests so partial returns are refunded correctly.",
    "This works the same on iOS and in Node.js projects.",
  ])("allows plain language: %s", (text) => {
    expect(containsCode(text)).toBe(false);
  });
});

class PlanGateway implements TaskModelGateway {
  readonly calls: string[] = [];
  constructor(private readonly plan: unknown, private readonly rewrite: unknown) {}
  async startTaskRun(): Promise<void> {}
  async call(_taskId: string, purpose: string): Promise<unknown> {
    this.calls.push(purpose);
    return purpose === "plan" ? this.plan : this.rewrite;
  }
  async finishTaskRun(): Promise<void> {}
}

describe("plan rewrite when code slips through", () => {
  const input = { taskId: "t", maskedTicket: "m", repositoryContext: "c", answers: [] };

  it("rewrites a plan that contains code and uses the plain version", async () => {
    const gateway = new PlanGateway(
      { whatIUnderstand: "Partial returns refund one unit.", proposedApproach: "Change 'total += item.unitPrice;' in `src/refund.js`.", size: "small" },
      { whatIUnderstand: "Partial returns refund one unit.", proposedApproach: "In `src/refund.js`, refund every returned unit." },
    );
    const plan = await new TaskPlanner({ gateway, spendCapUsd: 1 }).plan(input);
    expect(gateway.calls).toEqual(["plan", "rephrase-plan"]);
    expect(plan.proposedApproach).toBe("In `src/refund.js`, refund every returned unit.");
    expect(plan.size).toBe("small");
  });

  it("does not spend a second call on a plain plan", async () => {
    const gateway = new PlanGateway({ whatIUnderstand: "Partial returns refund one unit.", proposedApproach: "In `src/refund.js`, refund every returned unit.", size: "small" }, null);
    await new TaskPlanner({ gateway, spendCapUsd: 1 }).plan(input);
    expect(gateway.calls).toEqual(["plan"]);
  });

  it("keeps the original plan if the rewrite is unusable", async () => {
    const gateway = new PlanGateway({ whatIUnderstand: "w", proposedApproach: "Use calculateRefund()", size: "medium" }, { nope: true });
    const plan = await new TaskPlanner({ gateway, spendCapUsd: 1 }).plan(input);
    expect(plan.proposedApproach).toBe("Use calculateRefund()");
  });
});

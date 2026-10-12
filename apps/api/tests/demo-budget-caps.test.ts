import { describe, expect, it } from "vitest";
import { resolveDemoBudgetCaps } from "../src/demo-budget-caps.js";

describe("demo budget caps", () => {
  it("defaults to one dollar for planning and two dollars for implementation", () => {
    expect(resolveDemoBudgetCaps({})).toEqual({ planningUsd: 1, executionUsd: 2 });
  });

  it("uses positive configured caps and rejects invalid values", () => {
    expect(resolveDemoBudgetCaps({ TASK_MODEL_BUDGET_USD: "0.75", TASK_EXECUTION_BUDGET_USD: "1.50" })).toEqual({ planningUsd: 0.75, executionUsd: 1.5 });
    expect(() => resolveDemoBudgetCaps({ TASK_MODEL_BUDGET_USD: "0" })).toThrow(/TASK_MODEL_BUDGET_USD/);
    expect(() => resolveDemoBudgetCaps({ TASK_EXECUTION_BUDGET_USD: "NaN" })).toThrow(/TASK_EXECUTION_BUDGET_USD/);
  });
});

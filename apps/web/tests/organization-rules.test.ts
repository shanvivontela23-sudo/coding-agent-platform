import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { promptBudgetMessage, ruleStacksLabel } from "../src/organization-rules.js";

describe("coding rules page", () => {
  it("labels which projects a rule applies to", () => {
    const stacks = [{ id: "python", displayName: "Python" }, { id: "dotnet", displayName: ".NET / C#" }];
    expect(ruleStacksLabel({ appliesToStacks: null }, stacks)).toBe("All projects");
    expect(ruleStacksLabel({ appliesToStacks: ["python", "dotnet"] }, stacks)).toBe("Python, .NET / C# projects only");
  });

  it("warns when enabled rules exceed the space Dhara gives them", () => {
    expect(promptBudgetMessage(1_000, 4_000)).toEqual({ over: false, text: "Enabled rules use 25% of the space Dhara gives them in each task." });
    expect(promptBudgetMessage(5_000, 4_000).over).toBe(true);
    expect(promptBudgetMessage(5_000, 4_000).text).toContain("left out of tasks");
  });

  it("shows management controls only to owners and links the page from navigation", async () => {
    const page = await readFile("apps/web/app/rules/page.tsx", "utf8");
    expect(page).toContain('const isOwner = data.currentUser.role === "owner";');
    for (const control of ["Add rule", "Turn off", "Delete", "Save rule"]) expect(page).toContain(control);
    expect(page).toContain("Only an organization owner can add or change rules.");
    expect(page).toContain("/organization/rules");
    expect(await readFile("apps/web/components/app-shell.tsx", "utf8")).toContain('{ label: "Coding rules", href: "/rules" }');
  });
});

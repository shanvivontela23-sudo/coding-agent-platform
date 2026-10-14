// Display helpers for the coding rules page.
export type RuleView = { readonly id: string; readonly title: string; readonly body: string; readonly appliesToStacks: readonly string[] | null; readonly enabled: boolean; readonly updatedAt: string };
export type StackOption = { readonly id: string; readonly displayName: string };

export function ruleStacksLabel(rule: Pick<RuleView, "appliesToStacks">, stacks: readonly StackOption[]): string {
  if (!rule.appliesToStacks) return "All projects";
  const names = rule.appliesToStacks.map((id) => stacks.find((stack) => stack.id === id)?.displayName ?? id);
  return `${names.join(", ")} projects only`;
}

export function promptBudgetMessage(enabledChars: number, promptMaxChars: number): { readonly over: boolean; readonly text: string } {
  const percent = Math.min(999, Math.round((enabledChars / promptMaxChars) * 100));
  if (enabledChars > promptMaxChars) return { over: true, text: `Enabled rules use ${percent}% of the space Dhara gives them. Rules that do not fit are left out of tasks, starting with the newest. Shorten or disable some rules.` };
  return { over: false, text: `Enabled rules use ${percent}% of the space Dhara gives them in each task.` };
}

// What the project and task pages show about the stack skill Dhara will use.
// Only display names and commands reach the page: no internal skill ids, no
// raw output, and no invented command sources for older reports.
export type StackReportFields = {
  readonly stackSkill: string;
  readonly stackDisplayName?: string;
  readonly installCommand?: string | null;
  readonly testCommand: string | null;
  readonly buildCommand: string | null;
  readonly lintCommand?: string | null;
  readonly commandSources?: Readonly<Partial<Record<"install" | "test" | "build" | "lint", "repo" | "skill">>>;
};
export type StackBadgeModel =
  | { readonly kind: "skill"; readonly label: string; readonly commands: readonly { readonly role: string; readonly command: string; readonly source: "repo" | "skill" | null }[] }
  | { readonly kind: "generic"; readonly message: string };

export const genericStackMessage = "No stack skill for this project. Dhara will work it out, which may be slower.";
// Older reports carry only the skill id; map built-ins to their display names.
const builtInDisplayNames: Readonly<Record<string, string>> = { "typescript-node": "TypeScript / Node" };
const roleLabels = { install: "Install", test: "Test", build: "Build", lint: "Lint (hint only)" } as const;

export function stackBadgeModel(report: StackReportFields): StackBadgeModel {
  const name = report.stackSkill === "generic" ? null : report.stackDisplayName ?? builtInDisplayNames[report.stackSkill] ?? null;
  if (!name) return { kind: "generic", message: genericStackMessage };
  const values = { install: report.installCommand ?? null, test: report.testCommand, build: report.buildCommand, lint: report.lintCommand ?? null };
  const commands = (Object.keys(roleLabels) as (keyof typeof roleLabels)[]).flatMap((role) => {
    const command = values[role];
    return command ? [{ role: roleLabels[role], command, source: report.commandSources?.[role] ?? null }] : [];
  });
  return { kind: "skill", label: `Stack: ${name}`, commands };
}

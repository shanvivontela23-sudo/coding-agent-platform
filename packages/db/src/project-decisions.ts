export const projectDecisionKinds = [
  "command_worked",
  "command_failed",
  "convention",
  "reviewer_accepted",
  "reviewer_rejected",
  "rep_preference",
] as const;

export type ProjectDecisionKind = (typeof projectDecisionKinds)[number];

export const projectDecisionSources = ["verification", "publication", "zip_promotion", "plan_review"] as const;
export type ProjectDecisionSource = (typeof projectDecisionSources)[number];

export type ProjectDecision = {
  readonly id: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly taskId: string | null;
  readonly kind: ProjectDecisionKind;
  readonly summary: string;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly source: ProjectDecisionSource;
  readonly createdAt: string;
  readonly supersededBy: string | null;
};

export const projectHistoryMaxEntries = 15;
export const projectHistoryMaxChars = 3_200;
const openingTag = "<PROJECT_HISTORY>";
const closingTag = "</PROJECT_HISTORY>";

const kindLabels: Readonly<Record<ProjectDecisionKind, string>> = Object.freeze({
  command_worked: "Command worked",
  command_failed: "Command failed",
  convention: "Convention",
  reviewer_accepted: "Accepted outcome",
  reviewer_rejected: "Rejected outcome",
  rep_preference: "Representative preference",
});

export function normalizeDecisionSummary(value: string, mask: (value: string) => string): string {
  const normalized = mask(value).replace(/\s+/g, " ").trim();
  if (!normalized) throw new Error("project decision summary is required");
  return normalized.slice(0, 300);
}
export function formatProjectHistory(
  decisions: readonly ProjectDecision[],
  options: { readonly maxEntries?: number; readonly maxChars?: number } = {},
): string {
  const maxEntries = options.maxEntries ?? projectHistoryMaxEntries;
  const maxChars = options.maxChars ?? projectHistoryMaxChars;
  if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new Error("project history max entries must be a positive integer");
  const framingLength = openingTag.length + closingTag.length + 2;
  if (!Number.isInteger(maxChars) || maxChars <= framingLength + 2) throw new Error("project history max characters is too small");

  const current = decisions
    .filter((decision) => decision.supersededBy === null)
    .slice()
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
    .slice(0, maxEntries);
  if (current.length === 0) return "";

  const contentBudget = maxChars - framingLength;
  const lines: string[] = [];
  let used = 0;
  for (const decision of current) {
    const date = decision.createdAt.slice(0, 10);
    const prefix = `- ${date} · ${kindLabels[decision.kind]}: `;
    const separator = lines.length === 0 ? 0 : 1;
    const available = contentBudget - used - separator;
    if (available <= prefix.length) break;
    const safeSummary = decision.summary.replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\s+/g, " ").trim();
    const line = `${prefix}${safeSummary}`.slice(0, available).trimEnd();
    if (line.length <= prefix.length) break;
    lines.push(line);
    used += separator + line.length;
  }
  if (lines.length === 0) return "";
  return `${openingTag}\n${lines.join("\n")}\n${closingTag}`;
}


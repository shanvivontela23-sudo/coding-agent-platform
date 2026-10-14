import type { StackSkill, StackSkillDefinition } from "./schema.js";

export type CommandSource = "repo" | "skill";
export type TestRunner = "vitest" | "jest" | "mocha" | "node:test";
export type RepositorySkillEvidence = {
  readonly manifests: readonly string[];
  readonly languages: readonly string[];
  readonly packageManager: string | null;
  readonly scripts: Readonly<Record<string, string>>;
  readonly dependencies: readonly string[];
  readonly buildTools: readonly string[];
  readonly commands: { readonly install: string | null; readonly test: string | null; readonly build: string | null };
};
export type ResolvedCommands = { readonly install: string | null; readonly test: string | null; readonly build: string | null; readonly lint: string | null };
export type ResolvedStackSkill = {
  readonly skillId: string;
  readonly skillVersion: string | null;
  readonly displayName: string | null;
  readonly sandboxTemplateKey: string | null;
  readonly commands: ResolvedCommands;
  readonly commandSources: Readonly<Partial<Record<keyof ResolvedCommands, CommandSource>>>;
  readonly testRunner: TestRunner | null;
  readonly testSingleCommand: string | null;
  readonly verification: StackSkillDefinition["verification"] | null;
  readonly limits: StackSkillDefinition["limits"] | null;
};

export type StoredProjectReport = {
  readonly stackSkill: string;
  readonly stackSkillVersion?: string;
  readonly stackDisplayName?: string;
  readonly sandboxTemplateKey?: string;
  readonly packageManager: string | null;
  readonly installCommand?: string | null;
  readonly testCommand: string | null;
  readonly buildCommand: string | null;
  readonly lintCommand?: string | null;
  readonly commandSources?: Readonly<Partial<Record<keyof ResolvedCommands, CommandSource>>>;
  readonly testRunner?: TestRunner | null;
  readonly testSingleCommand?: string | null;
  readonly manifests: readonly string[];
};

const supportedManagers = new Set(["pnpm", "npm", "yarn", "bun"]);
const dependencyRunners = ["vitest", "jest", "mocha"] as const;

function managerCommand(commands: Readonly<Partial<Record<string, string>>> | undefined, manager: string | null): string | null {
  return manager && supportedManagers.has(manager) ? commands?.[manager] ?? null : null;
}
function commandWithSource(command: string | null, source: CommandSource, role: keyof ResolvedCommands, values: Record<keyof ResolvedCommands, string | null>, sources: Partial<Record<keyof ResolvedCommands, CommandSource>>): void {
  values[role] = command;
  if (command) sources[role] = source;
}
function detectedRunner(evidence: RepositorySkillEvidence): TestRunner | null {
  const dependencies = new Set(evidence.dependencies.map((value) => value.toLowerCase()));
  const found: TestRunner[] = dependencyRunners.filter((runner) => dependencies.has(runner));
  if (/\bnode\s+--test\b/.test(evidence.scripts.test ?? "")) found.push("node:test");
  return found.length === 1 ? found[0] ?? null : null;
}
function matches(skill: StackSkill, evidence: RepositorySkillEvidence): boolean {
  const manifests = new Set(evidence.manifests);
  if (!skill.detect.manifests.some((manifest) => manifests.has(manifest))) return false;
  const markers = new Set([...evidence.languages, ...evidence.dependencies].map((value) => value.toLowerCase()));
  return skill.detect.markers.some((marker) => markers.has(marker.toLowerCase()));
}
function installEvidence(manager: string | null, manifests: readonly string[]): boolean {
  const names = new Set(manifests);
  if (manager === "pnpm") return names.has("pnpm-lock.yaml");
  if (manager === "npm") return names.has("package-lock.json");
  if (manager === "yarn") return names.has("yarn.lock");
  if (manager === "bun") return names.has("bun.lock") || names.has("bun.lockb");
  return false;
}
function generic(evidence: RepositorySkillEvidence): ResolvedStackSkill {
  const values: Record<keyof ResolvedCommands, string | null> = { install: null, test: null, build: null, lint: null };
  const sources: Partial<Record<keyof ResolvedCommands, CommandSource>> = {};
  commandWithSource(evidence.commands.install, "repo", "install", values, sources);
  commandWithSource(evidence.commands.test, "repo", "test", values, sources);
  commandWithSource(evidence.commands.build, "repo", "build", values, sources);
  return { skillId: "generic", skillVersion: null, displayName: null, sandboxTemplateKey: null, commands: values, commandSources: sources, testRunner: null, testSingleCommand: null, verification: null, limits: null };
}

export function resolveRepositorySkill(evidence: RepositorySkillEvidence, skills: ReadonlyMap<string, StackSkill>): ResolvedStackSkill {
  const skill = [...skills.values()].find((candidate) => matches(candidate, evidence));
  if (!skill) return generic(evidence);
  const manager = evidence.packageManager;
  const runner = detectedRunner(evidence);
  const values: Record<keyof ResolvedCommands, string | null> = { install: null, test: null, build: null, lint: null };
  const sources: Partial<Record<keyof ResolvedCommands, CommandSource>> = {};
  const skillInstall = installEvidence(manager, evidence.manifests) ? managerCommand(skill.defaults.install, manager) : null;
  commandWithSource(evidence.commands.install ?? skillInstall, evidence.commands.install ? "repo" : "skill", "install", values, sources);
  const skillTest = evidence.scripts.test
    ? managerCommand(skill.defaults.test, manager)
    : runner ? managerCommand(skill.defaults.testRunner[runner], manager) : null;
  commandWithSource(evidence.commands.test ?? skillTest, evidence.commands.test ? "repo" : "skill", "test", values, sources);
  const skillBuild = evidence.scripts.build ? managerCommand(skill.defaults.build, manager) : null;
  commandWithSource(evidence.commands.build ?? skillBuild, evidence.commands.build ? "repo" : "skill", "build", values, sources);
  const skillLint = evidence.scripts.lint ? managerCommand(skill.defaults.lint, manager) : null;
  commandWithSource(skillLint, "skill", "lint", values, sources);
  return {
    skillId: skill.id,
    skillVersion: skill.version,
    displayName: skill.displayName,
    sandboxTemplateKey: skill.sandboxTemplateKey,
    commands: values,
    commandSources: sources,
    testRunner: runner,
    testSingleCommand: runner ? skill.defaults.testSingle[runner] ?? null : null,
    verification: skill.verification,
    limits: skill.limits ?? null,
  };
}

export function resolveStoredProjectReport(report: StoredProjectReport, skills: ReadonlyMap<string, StackSkill>): ResolvedStackSkill {
  const skill = skills.get(report.stackSkill);
  const trusted = skill && (!report.stackSkillVersion || report.stackSkillVersion === skill.version) ? skill : null;
  const testRunner = report.testRunner ?? null;
  return {
    skillId: trusted?.id ?? report.stackSkill,
    skillVersion: trusted?.version ?? null,
    displayName: report.stackDisplayName ?? trusted?.displayName ?? null,
    sandboxTemplateKey: report.sandboxTemplateKey ?? trusted?.sandboxTemplateKey ?? null,
    commands: { install: report.installCommand ?? null, test: report.testCommand, build: report.buildCommand, lint: report.lintCommand ?? null },
    commandSources: report.commandSources ?? {},
    testRunner,
    testSingleCommand: report.testSingleCommand ?? (testRunner && trusted ? trusted.defaults.testSingle[testRunner] ?? null : null),
    verification: trusted?.verification ?? null,
    limits: trusted?.limits ?? null,
  };
}

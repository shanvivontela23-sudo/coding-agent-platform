import { stackPackageManagers, type StackSkill, type StackSkillDefinition, type stackTestRunners } from "./schema.js";

export type CommandSource = "repo" | "skill";
export type TestRunner = (typeof stackTestRunners)[number];
type Manager = (typeof stackPackageManagers)[number];
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
  // Other stacks that also matched this repository (display names), e.g. a
  // Node frontend next to a Java backend. Only the primary stack is used.
  readonly otherStacks: readonly string[];
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

const supportedManagers = new Set<string>(stackPackageManagers);
const dependencyRunners = ["vitest", "jest", "mocha"] as const;

function managerCommand(commands: Readonly<Partial<Record<string, string>>> | undefined, manager: string | null): string | null {
  return manager && supportedManagers.has(manager) ? commands?.[manager] ?? null : null;
}
function commandWithSource(command: string | null, source: CommandSource, role: keyof ResolvedCommands, values: Record<keyof ResolvedCommands, string | null>, sources: Partial<Record<keyof ResolvedCommands, CommandSource>>): void {
  values[role] = command;
  if (command) sources[role] = source;
}
function manifestMatches(pattern: string, manifest: string): boolean {
  return pattern.startsWith("*.") ? manifest.toLowerCase().endsWith(pattern.slice(1).toLowerCase()) && manifest.length > pattern.length - 1 : manifest === pattern;
}
function hasManifest(evidence: RepositorySkillEvidence, pattern: string): boolean {
  return evidence.manifests.some((manifest) => manifestMatches(pattern, manifest));
}
// Node managers come from lockfiles (analysis); other build tools are read
// from the skill's own manifests so a Java or .NET repo still gets a key.
function managerFor(skill: StackSkill, evidence: RepositorySkillEvidence): Manager | null {
  const reported = evidence.packageManager;
  const candidates: Manager[] = [];
  if (reported && supportedManagers.has(reported)) candidates.push(reported as Manager);
  if (hasManifest(evidence, "mvnw")) candidates.push("maven-wrapper");
  if (hasManifest(evidence, "pom.xml")) candidates.push("maven");
  if (hasManifest(evidence, "gradlew")) candidates.push("gradle-wrapper");
  if (hasManifest(evidence, "build.gradle") || hasManifest(evidence, "build.gradle.kts")) candidates.push("gradle");
  if (hasManifest(evidence, "*.sln") || hasManifest(evidence, "*.csproj")) candidates.push("dotnet");
  if (hasManifest(evidence, "requirements.txt") || hasManifest(evidence, "pyproject.toml") || hasManifest(evidence, "setup.py")) candidates.push("pip");
  const commandSets = [skill.defaults.install, skill.defaults.test, skill.defaults.build, ...Object.values(skill.defaults.testRunner)];
  const known = (manager: Manager) => commandSets.some((commands) => Boolean(commands?.[manager])) || Boolean(skill.detect.managerRunners?.[manager]);
  return candidates.find(known) ?? null;
}
function detectedRunner(skill: StackSkill, evidence: RepositorySkillEvidence, manager: Manager | null): TestRunner | null {
  const byManager = manager ? skill.detect.managerRunners?.[manager] ?? null : null;
  if (byManager) return byManager;
  const dependencies = new Set(evidence.dependencies.map((value) => value.toLowerCase()));
  if (skill.detect.runners) {
    const found = (Object.entries(skill.detect.runners) as [TestRunner, readonly string[] | undefined][])
      .filter(([, markers]) => markers?.some((marker) => dependencies.has(marker.toLowerCase())))
      .map(([runner]) => runner);
    return found.length === 1 ? found[0] ?? null : null;
  }
  const found: TestRunner[] = dependencyRunners.filter((runner) => dependencies.has(runner));
  if (/\bnode\s+--test\b/.test(evidence.scripts.test ?? "")) found.push("node:test");
  return found.length === 1 ? found[0] ?? null : null;
}
function matches(skill: StackSkill, evidence: RepositorySkillEvidence): boolean {
  if (!skill.detect.manifests.some((pattern) => hasManifest(evidence, pattern))) return false;
  const markers = new Set([...evidence.languages, ...evidence.dependencies].map((value) => value.toLowerCase()));
  return skill.detect.markers.some((marker) => markers.has(marker.toLowerCase()));
}
// Primary stack: the matching skill whose language has the most files
// (analysis lists languages by file count). A skill confirmed only by a
// dependency ranks after every language match; ties keep registry order.
function languageRank(skill: StackSkill, evidence: RepositorySkillEvidence): number {
  const languages = evidence.languages.map((language) => language.toLowerCase());
  const ranks = skill.detect.markers.map((marker) => languages.indexOf(marker.toLowerCase())).filter((index) => index >= 0);
  return ranks.length > 0 ? Math.min(...ranks) : languages.length;
}
function installEvidence(manager: string | null, evidence: RepositorySkillEvidence): boolean {
  const has = (pattern: string) => hasManifest(evidence, pattern);
  switch (manager) {
    case "pnpm": return has("pnpm-lock.yaml");
    case "npm": return has("package-lock.json");
    case "yarn": return has("yarn.lock");
    case "bun": return has("bun.lock") || has("bun.lockb");
    case "uv": return has("uv.lock");
    case "poetry": return has("poetry.lock");
    case "pipenv": return has("Pipfile.lock");
    case "pip": return has("requirements.txt");
    case "maven": return has("pom.xml");
    case "maven-wrapper": return has("mvnw") && has("pom.xml");
    case "gradle": return has("build.gradle") || has("build.gradle.kts");
    case "gradle-wrapper": return has("gradlew");
    case "dotnet": return has("*.sln") || has("*.csproj");
    default: return false;
  }
}
function generic(evidence: RepositorySkillEvidence): ResolvedStackSkill {
  const values: Record<keyof ResolvedCommands, string | null> = { install: null, test: null, build: null, lint: null };
  const sources: Partial<Record<keyof ResolvedCommands, CommandSource>> = {};
  commandWithSource(evidence.commands.install, "repo", "install", values, sources);
  commandWithSource(evidence.commands.test, "repo", "test", values, sources);
  commandWithSource(evidence.commands.build, "repo", "build", values, sources);
  return { skillId: "generic", skillVersion: null, displayName: null, sandboxTemplateKey: null, commands: values, commandSources: sources, testRunner: null, testSingleCommand: null, verification: null, limits: null, otherStacks: [] };
}

export function resolveRepositorySkill(evidence: RepositorySkillEvidence, skills: ReadonlyMap<string, StackSkill>): ResolvedStackSkill {
  const matching = [...skills.values()].filter((candidate) => matches(candidate, evidence));
  const ranked = matching.map((candidate, order) => ({ candidate, order, rank: languageRank(candidate, evidence) })).sort((left, right) => left.rank - right.rank || left.order - right.order);
  const skill = ranked[0]?.candidate;
  if (!skill) return generic(evidence);
  const otherStacks = ranked.slice(1).map((entry) => entry.candidate.displayName);
  const manager = managerFor(skill, evidence);
  const runner = detectedRunner(skill, evidence, manager);
  const values: Record<keyof ResolvedCommands, string | null> = { install: null, test: null, build: null, lint: null };
  const sources: Partial<Record<keyof ResolvedCommands, CommandSource>> = {};
  const skillInstall = installEvidence(manager, evidence) ? managerCommand(skill.defaults.install, manager) : null;
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
    otherStacks,
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
    otherStacks: [],
  };
}

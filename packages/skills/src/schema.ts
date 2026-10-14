import { z } from "zod";

export const stackCommandRoles = ["install", "test", "build"] as const;
export const stackTestRunners = ["vitest", "jest", "mocha", "node:test", "pytest", "maven-surefire", "gradle-test", "dotnet-test"] as const;
// Package managers and build tools a skill can key commands by. Node managers
// come from lockfiles; the others are derived from manifests during resolution.
export const stackPackageManagers = ["pnpm", "npm", "yarn", "bun", "pip", "uv", "poetry", "pipenv", "maven", "maven-wrapper", "gradle", "gradle-wrapper", "dotnet"] as const;
export const stackGuideTokenCap = 1_500;

const nonEmptySingleLine = z.string().trim().min(1).refine((value) => !/[\0\r\n]/.test(value), "must be a single line without NUL bytes");
const commandSchema = nonEmptySingleLine;
const managerCommandsSchema = z.object(Object.fromEntries(stackPackageManagers.map((manager) => [manager, commandSchema.optional()])) as Record<(typeof stackPackageManagers)[number], z.ZodOptional<typeof commandSchema>>)
  .strict().refine((commands) => Object.values(commands).some(Boolean), "must configure at least one package manager command");
const runnerCommandsSchema = z.object(Object.fromEntries(stackTestRunners.map((runner) => [runner, managerCommandsSchema.optional()])) as Record<(typeof stackTestRunners)[number], z.ZodOptional<typeof managerCommandsSchema>>).strict();

// A focused-test template takes the full test command as {test} and the test
// file either as {path} or as its class name {class} (JVM and .NET runners
// select tests by class, not by file).
const testSingleTemplateSchema = commandSchema.superRefine((template, context) => {
  const targets = (template.match(/\{path\}/g)?.length ?? 0) + (template.match(/\{class\}/g)?.length ?? 0);
  if (targets !== 1) context.addIssue({ code: "custom", message: "must contain exactly one {path} or {class} placeholder" });
  const testPlaceholders = template.match(/\{test\}/g)?.length ?? 0;
  if (testPlaceholders > 1) context.addIssue({ code: "custom", message: "may contain at most one {test} placeholder" });
  const unknown = template.match(/\{[^}]+\}/g)?.filter((placeholder) => placeholder !== "{path}" && placeholder !== "{class}" && placeholder !== "{test}") ?? [];
  if (unknown.length > 0) context.addIssue({ code: "custom", message: `contains unsupported placeholder ${unknown[0]}` });
});
const runnerTemplatesSchema = z.object(Object.fromEntries(stackTestRunners.map((runner) => [runner, testSingleTemplateSchema.optional()])) as Record<(typeof stackTestRunners)[number], z.ZodOptional<typeof testSingleTemplateSchema>>).strict();

const definitionSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "must be a lowercase kebab-case id"),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, "must be a semantic version"),
  displayName: z.string().trim().min(1).max(100),
  detect: z.object({
    // Exact manifest names, or "*.ext" to match any manifest with that suffix.
    manifests: z.array(nonEmptySingleLine).min(1),
    // Languages (as analysis names them) or dependency names that confirm the stack.
    markers: z.array(nonEmptySingleLine).min(1),
    // Optional: a runner is detected when exactly one runner's dependency markers are present.
    runners: z.object(Object.fromEntries(stackTestRunners.map((runner) => [runner, z.array(nonEmptySingleLine).min(1).optional()])) as Record<(typeof stackTestRunners)[number], z.ZodOptional<z.ZodArray<typeof nonEmptySingleLine>>>).strict().optional(),
    // Optional: the build tool alone fixes the runner (Maven -> Surefire, dotnet -> dotnet test).
    managerRunners: z.object(Object.fromEntries(stackPackageManagers.map((manager) => [manager, z.enum(stackTestRunners).optional()])) as Record<(typeof stackPackageManagers)[number], z.ZodOptional<z.ZodEnum<{ [K in (typeof stackTestRunners)[number]]: K }>>>).strict().optional(),
  }).strict(),
  sandboxTemplateKey: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "must be a lowercase kebab-case key"),
  defaults: z.object({
    install: managerCommandsSchema.optional(),
    build: managerCommandsSchema.optional(),
    test: managerCommandsSchema.optional(),
    testRunner: runnerCommandsSchema.default({}),
    lint: managerCommandsSchema.optional(),
    testSingle: runnerTemplatesSchema.default({}),
  }).strict(),
  verification: z.array(z.object({
    name: z.enum(stackCommandRoles),
    commandRole: z.enum(stackCommandRoles),
    environmentFailurePatterns: z.array(nonEmptySingleLine).default([]),
  }).strict()).min(1),
  limits: z.object({
    installTimeoutMs: z.number().int().positive().optional(),
    testTimeoutMs: z.number().int().positive().optional(),
    buildTimeoutMs: z.number().int().positive().optional(),
  }).strict().optional(),
}).strict().superRefine((definition, context) => {
  const seen = new Set<string>();
  for (const [index, check] of definition.verification.entries()) {
    if (seen.has(check.name)) context.addIssue({ code: "custom", path: ["verification", index, "name"], message: `duplicate verification step ${check.name}` });
    seen.add(check.name);
    if (check.name !== check.commandRole) context.addIssue({ code: "custom", path: ["verification", index, "commandRole"], message: "must match the verification step name" });
    for (const [patternIndex, pattern] of check.environmentFailurePatterns.entries()) {
      try { new RegExp(pattern, "i"); }
      catch { context.addIssue({ code: "custom", path: ["verification", index, "environmentFailurePatterns", patternIndex], message: "must be a valid regular expression" }); }
    }
  }
});

export type StackSkillDefinition = z.infer<typeof definitionSchema>;
export type StackSkill = Readonly<StackSkillDefinition & {
  readonly guide: string;
  readonly guideTokenEstimate: number;
}>;

export function estimateConservativeTokens(value: string): number {
  return Math.ceil(Buffer.byteLength(value, "utf8") / 3);
}

function schemaError(source: string, error: z.ZodError): Error {
  const issue = error.issues[0];
  const path = issue?.path.length ? issue.path.join(".") : "definition";
  return new Error(`Invalid stack skill ${source} at ${path}: ${issue?.message ?? "schema validation failed"}`);
}

export function parseStackSkillDefinition(input: unknown, guideValue: string, source: string): StackSkill {
  const parsed = definitionSchema.safeParse(input);
  if (!parsed.success) throw schemaError(source, parsed.error);
  const guide = guideValue.trim();
  if (!guide) throw new Error(`Invalid stack skill ${source} at guide: guide is required`);
  const guideTokenEstimate = estimateConservativeTokens(guide);
  if (guideTokenEstimate > stackGuideTokenCap) throw new Error(`Invalid stack skill ${source} at guide: guide exceeds the 1,500 token cap`);
  return Object.freeze({ ...parsed.data, guide, guideTokenEstimate });
}

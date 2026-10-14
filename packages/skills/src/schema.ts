import { z } from "zod";

export const stackCommandRoles = ["install", "test", "build"] as const;
export const stackTestRunners = ["vitest", "jest", "mocha", "node:test"] as const;
export const stackPackageManagers = ["pnpm", "npm", "yarn", "bun"] as const;
export const stackGuideTokenCap = 1_500;

const nonEmptySingleLine = z.string().trim().min(1).refine((value) => !/[\0\r\n]/.test(value), "must be a single line without NUL bytes");
const commandSchema = nonEmptySingleLine;
const managerCommandsSchema = z.object({
  pnpm: commandSchema.optional(),
  npm: commandSchema.optional(),
  yarn: commandSchema.optional(),
  bun: commandSchema.optional(),
}).strict().refine((commands) => Object.values(commands).some(Boolean), "must configure at least one package manager command");

const testSingleTemplateSchema = commandSchema.superRefine((template, context) => {
  const pathPlaceholders = template.match(/\{path\}/g)?.length ?? 0;
  if (pathPlaceholders !== 1) context.addIssue({ code: "custom", message: "must contain exactly one {path} placeholder" });
  const testPlaceholders = template.match(/\{test\}/g)?.length ?? 0;
  if (testPlaceholders > 1) context.addIssue({ code: "custom", message: "may contain at most one {test} placeholder" });
  const unknown = template.match(/\{[^}]+\}/g)?.filter((placeholder) => placeholder !== "{path}" && placeholder !== "{test}") ?? [];
  if (unknown.length > 0) context.addIssue({ code: "custom", message: `contains unsupported placeholder ${unknown[0]}` });
});

const definitionSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "must be a lowercase kebab-case id"),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, "must be a semantic version"),
  displayName: z.string().trim().min(1).max(100),
  detect: z.object({
    manifests: z.array(nonEmptySingleLine).min(1),
    markers: z.array(nonEmptySingleLine).min(1),
  }).strict(),
  sandboxTemplateKey: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "must be a lowercase kebab-case key"),
  defaults: z.object({
    install: managerCommandsSchema.optional(),
    build: managerCommandsSchema.optional(),
    test: managerCommandsSchema.optional(),
    lint: managerCommandsSchema.optional(),
    testSingle: z.object({
      vitest: testSingleTemplateSchema.optional(),
      jest: testSingleTemplateSchema.optional(),
      mocha: testSingleTemplateSchema.optional(),
      "node:test": testSingleTemplateSchema.optional(),
    }).strict().default({}),
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

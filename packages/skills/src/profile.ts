import { z } from "zod";
import { resolveStoredProjectReport, type StoredProjectReport } from "./resolution.js";
import { stackCommandRoles, stackTestRunners, type StackSkill } from "./schema.js";

// One immutable profile per execution. It is resolved once before any sandbox
// or model work, persisted, and reloaded on reclaim, so coding, baseline
// verification and patched verification all see the same skill version,
// commands, guide text and sandbox template even if built-ins or environment
// configuration change mid-run.
const command = z.string().min(1).max(2_000).refine((value) => !/[\0\r\n]/.test(value), "single line");
const skillVersion = z.string().regex(/^\d+\.\d+\.\d+$/);
const skillId = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const profileSchema = z.object({
  profileVersion: z.literal(1),
  skillId: skillId.nullable(),
  skillVersion: skillVersion.nullable(),
  displayName: z.string().max(100).nullable(),
  planningSkillId: skillId.nullable(),
  planningSkillVersion: skillVersion.nullable(),
  commands: z.object({ install: command.nullable(), test: command.nullable(), build: command.nullable(), lint: command.nullable() }).strict(),
  commandSources: z.object({ install: z.enum(["repo", "skill"]).optional(), test: z.enum(["repo", "skill"]).optional(), build: z.enum(["repo", "skill"]).optional(), lint: z.enum(["repo", "skill"]).optional() }).strict(),
  testRunner: z.enum(stackTestRunners).nullable(),
  testSingleTemplate: command.nullable(),
  verification: z.array(z.object({ name: z.enum(stackCommandRoles), commandRole: z.enum(stackCommandRoles), environmentFailurePatterns: z.array(z.string().max(500)).max(50) }).strict()).max(3).nullable(),
  limits: z.object({ installTimeoutMs: z.number().int().positive().optional(), testTimeoutMs: z.number().int().positive().optional(), buildTimeoutMs: z.number().int().positive().optional() }).strict().nullable(),
  guide: z.string().max(20_000).nullable(),
  sandboxTemplateId: z.string().min(1).max(200).regex(/^\S+$/),
  // Organization rules that applied to this run (optional: older profiles have none).
  organizationRules: z.array(z.object({ id: z.string().uuid(), title: z.string().min(1).max(100), body: z.string().min(1).max(2_000) }).strict()).max(20).optional(),
}).strict().superRefine((profile, context) => {
  if ((profile.skillId === null) !== (profile.skillVersion === null)) context.addIssue({ code: "custom", message: "skill id and version must both be set or both be null" });
  if ((profile.planningSkillId === null) !== (profile.planningSkillVersion === null)) context.addIssue({ code: "custom", message: "planning skill id and version must both be set or both be null" });
});

export type ExecutionProfile = z.infer<typeof profileSchema>;

export function parseExecutionProfile(value: unknown): ExecutionProfile {
  const parsed = profileSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Stored execution profile is invalid at ${parsed.error.issues[0]?.path.join(".") || "profile"}`);
  return parsed.data;
}

// A skill names a template key; the deployment maps it to a real E2B template
// id through E2B_TEMPLATE_<KEY>. An unset key, a generic project or a legacy
// report uses the universal E2B_TEMPLATE_ID.
export function sandboxTemplateEnvName(key: string): string {
  return `E2B_TEMPLATE_${key.toUpperCase().replace(/-/g, "_")}`;
}

export function resolveSandboxTemplateId(key: string | null, env: Readonly<Record<string, string | undefined>>, fallbackTemplateId: string): string {
  const fallback = fallbackTemplateId.trim();
  if (!fallback) throw new Error("E2B_TEMPLATE_ID is required as the fallback sandbox template");
  if (!key) return fallback;
  const keyed = env[sandboxTemplateEnvName(key)]?.trim();
  return keyed && /^\S+$/.test(keyed) ? keyed : fallback;
}

export function buildExecutionProfile(input: {
  readonly report: StoredProjectReport;
  readonly skills: ReadonlyMap<string, StackSkill>;
  readonly planningSkill: { readonly id: string; readonly version: string } | null;
  readonly sandboxTemplateId: (templateKey: string | null) => string;
}): ExecutionProfile {
  const resolved = resolveStoredProjectReport(input.report, input.skills);
  const skill = resolved.skillVersion ? input.skills.get(resolved.skillId) ?? null : null;
  const trusted = skill && skill.version === resolved.skillVersion ? skill : null;
  return parseExecutionProfile({
    profileVersion: 1,
    skillId: trusted?.id ?? null,
    skillVersion: trusted?.version ?? null,
    displayName: trusted?.displayName ?? null,
    planningSkillId: input.planningSkill?.id ?? null,
    planningSkillVersion: input.planningSkill?.version ?? null,
    commands: resolved.commands,
    commandSources: resolved.commandSources,
    testRunner: trusted ? resolved.testRunner : null,
    testSingleTemplate: trusted ? resolved.testSingleCommand : null,
    verification: trusted ? trusted.verification : null,
    limits: trusted?.limits ?? null,
    guide: trusted?.guide ?? null,
    sandboxTemplateId: input.sandboxTemplateId(trusted ? trusted.sandboxTemplateKey : null),
  });
}

function shellArg(value: string): string {
  return /^[A-Za-z0-9_./:@+-]+$/.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`;
}

// Paths come from a model-written patch and are untrusted. Only plain
// workspace-relative paths survive; everything else yields no focused command.
export function safeWorkspaceRelativePath(path: string): string | null {
  if (!path || path.length > 1_000 || /[\0\r\n]/.test(path)) return null;
  const normalized = path.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) return null;
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "..")) return null;
  const cleaned = segments.filter((segment) => segment !== "" && segment !== ".");
  if (cleaned.length === 0) return null;
  if (cleaned[0]!.startsWith("-")) return null;
  return cleaned.join("/");
}

// npm swallows flags after a script name unless they follow "--".
function argumentPassingCommand(testCommand: string): string {
  return /^npm (?:test|t|run(?:-script)? \S+)$/.test(testCommand.trim()) ? `${testCommand.trim()} --` : testCommand;
}

// JVM and .NET runners select tests by class: the file's base name, which must
// be a plain identifier (no shell metacharacters can get through).
export function testClassName(path: string): string | null {
  const base = path.split("/").at(-1) ?? "";
  const name = base.replace(/\.(?:java|kt|kts|scala|groovy|cs|fs|vb)$/i, "");
  return name !== base && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : null;
}

export function focusedTestCommand(input: { readonly testCommand: string | null; readonly testSingleTemplate: string | null; readonly path: string }): string | null {
  if (!input.testCommand) return null;
  const path = safeWorkspaceRelativePath(input.path);
  if (!path) return null;
  const quoted = shellArg(path);
  const test = argumentPassingCommand(input.testCommand);
  // Function replacers: a command or path containing "$&" must not be expanded.
  if (input.testSingleTemplate?.includes("{class}")) {
    const className = testClassName(path);
    return className ? input.testSingleTemplate.replace("{test}", () => test).replace("{class}", () => className) : null;
  }
  if (input.testSingleTemplate) return input.testSingleTemplate.replace("{test}", () => test).replace("{path}", () => quoted);
  return `${test} ${quoted}`;
}

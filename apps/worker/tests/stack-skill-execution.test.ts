import { beforeAll, describe, expect, it, vi } from "vitest";
import type { SandboxCommand, SandboxCommandResult, SandboxCreateRequest, SandboxPatch, SandboxProvider, SandboxSession, SandboxSnapshot } from "../../../evals/src/sandbox/types.js";
import { buildExecutionProfile, type ExecutionProfile } from "../../../packages/skills/src/profile.js";
import { loadBuiltInStackSkills } from "../../../packages/skills/src/registry.js";
import type { StackSkill } from "../../../packages/skills/src/schema.js";
import { applyExecutionProfile, type PreparedExecutionSource } from "../src/execution-source.js";
import type { ExecutionProgress, ExecutionStore } from "../src/execution-store.js";
import { codingTaskText, type ProductCodingResult, type ProductCodingRunner } from "../src/product-coding-runner.js";
import { ProductExecutionOrchestrator } from "../src/product-execution-orchestrator.js";
import type { ClaimedExecution } from "../src/postgres-execution-queue.js";
import { verificationSetupFailureText, verifyExecution, type VerificationResult } from "../src/verification.js";

let skills: ReadonlyMap<string, StackSkill>;
beforeAll(async () => { skills = await loadBuiltInStackSkills(); });

const execution: ClaimedExecution = {
  executionId: "50000000-0000-4000-8000-000000000613",
  organizationId: "00000000-0000-4000-8000-000000000613",
  taskId: "40000000-0000-4000-8000-000000000613",
  projectId: "20000000-0000-4000-8000-000000000613",
  attempt: 1,
  sourceCommitSha: "a".repeat(40),
  sourceVersionId: null,
  budgetUsd: 2,
  timeoutSeconds: 100,
};
const tsReport = { stackSkill: "typescript-node", stackSkillVersion: "1.0.0", packageManager: "pnpm", installCommand: "pnpm install --frozen-lockfile", testCommand: "pnpm test", buildCommand: "pnpm build", lintCommand: "pnpm lint", testRunner: "vitest" as const, manifests: ["package.json", "pnpm-lock.yaml"] };
const baseSource: PreparedExecutionSource = {
  repository: { pinnedCommit: "a".repeat(40), archiveSha256: "b".repeat(64), archive: new Uint8Array([1]) },
  jobType: "bug_fix",
  requirement: "Retry should recover",
  plan: "Fix state and add regression coverage",
  commands: { install: "pnpm install --frozen-lockfile", test: "pnpm test", build: "pnpm build" },
  reviewFocus: "retry state",
  report: tsReport,
  planningSkill: { id: "typescript-node", version: "1.0.0" },
};
function profile(templateId = "tpl-ts"): ExecutionProfile {
  return buildExecutionProfile({ report: tsReport, skills, planningSkill: { id: "typescript-node", version: "1.0.0" }, sandboxTemplateId: () => templateId });
}
const patch = [
  "diff --git a/src/retry.ts b/src/retry.ts", "--- a/src/retry.ts", "+++ b/src/retry.ts", "@@ -1 +1 @@", "-export const v = 1;", "+export const v = 2;",
  "diff --git /dev/null b/src/retry.test.ts", "new file mode 100644", "--- /dev/null", "+++ b/src/retry.test.ts", "@@ -0,0 +1 @@", "+test('retry',()=>{});", "",
].join("\n");

describe("execution profile pinning in the orchestrator", () => {
  const verification: VerificationResult = { checks: [], hasNewFailures: false, complete: true, incompleteReason: null, reproduce: { command: null, baselineExitCode: null, patchedExitCode: null, baselineOutput: "", patchedOutput: "", baselineClassification: "not_run", patchedClassification: "not_run", reproduced: true, reason: null } };
  function store(stored: ExecutionProfile | null, options: { failPin?: boolean } = {}): ExecutionStore & { calls: string[]; pinned: ExecutionProfile | null } {
    let state: ExecutionProgress = { sourcePreparedAt: null, codingStartedAt: null, codingFinishedAt: null, patchExportedAt: null, verifiedAt: null, resultPatch: null, resultMetadata: {} };
    const result = {
      calls: [] as string[], pinned: stored,
      async getProgress() { return state; },
      async pinExecutionProfile(_execution: ClaimedExecution, candidate: ExecutionProfile) { result.calls.push("pin"); if (options.failPin) throw new Error("database down"); result.pinned ??= candidate; return result.pinned; },
      async markSourcePrepared() { result.calls.push("source_prepared"); state = { ...state, sourcePreparedAt: "now" }; },
      async markCodingStarted() { result.calls.push("coding_started"); state = { ...state, codingStartedAt: "now" }; },
      async saveCost() {},
      async saveSafeCodingOutput(_execution: ClaimedExecution, input: { patch: string }) { state = { ...state, codingFinishedAt: "now", patchExportedAt: "now", resultPatch: input.patch }; },
      async saveVerification() {},
    };
    return result;
  }

  it("pins before marking the source prepared and hands the same profile to coding and verification", async () => {
    const durable = store(null);
    const seen: (ExecutionProfile | undefined)[] = [];
    const coder = { run: vi.fn(async (_id: string, source: PreparedExecutionSource): Promise<ProductCodingResult> => { durable.calls.push("coding"); seen.push(source.executionProfile); return { patch, reproductionCommand: null, costUsd: 0.1, summary: "ok" }; }) } as unknown as ProductCodingRunner;
    const orchestrator = new ProductExecutionOrchestrator({ store: durable, sourceProvider: { prepare: async () => baseSource }, codingRunner: coder, verificationSandboxProvider: {} as SandboxProvider, patchLimits: { maxFiles: 10, maxBytes: 100_000 }, resolveProfile: () => profile(), verify: async (options) => { seen.push(options.source.executionProfile); return verification; } });
    await orchestrator.run(execution, { signal: new AbortController().signal });
    expect(durable.calls.slice(0, 3)).toEqual(["pin", "source_prepared", "coding_started"]);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual(seen[1]);
    expect(seen[0]?.sandboxTemplateId).toBe("tpl-ts");
  });

  it("reuses the stored profile on reclaim even if configuration changed", async () => {
    const original = profile("tpl-original");
    const durable = store(original);
    let codedWith: ExecutionProfile | undefined;
    const coder = { run: async (_id: string, source: PreparedExecutionSource) => { codedWith = source.executionProfile; return { patch, reproductionCommand: null, costUsd: 0.1, summary: "ok" }; } } as unknown as ProductCodingRunner;
    const orchestrator = new ProductExecutionOrchestrator({ store: durable, sourceProvider: { prepare: async () => baseSource }, codingRunner: coder, verificationSandboxProvider: {} as SandboxProvider, patchLimits: { maxFiles: 10, maxBytes: 100_000 }, resolveProfile: () => profile("tpl-changed"), verify: async () => verification });
    await orchestrator.run(execution, { signal: new AbortController().signal });
    expect(codedWith?.sandboxTemplateId).toBe("tpl-original");
  });

  it("starts no sandbox or model work when the profile cannot be persisted", async () => {
    const durable = store(null, { failPin: true });
    const coder = { run: vi.fn() } as unknown as ProductCodingRunner;
    const orchestrator = new ProductExecutionOrchestrator({ store: durable, sourceProvider: { prepare: async () => baseSource }, codingRunner: coder, verificationSandboxProvider: {} as SandboxProvider, patchLimits: { maxFiles: 10, maxBytes: 100_000 }, resolveProfile: () => profile(), verify: async () => verification });
    await expect(orchestrator.run(execution, { signal: new AbortController().signal })).rejects.toThrow(/database down/);
    expect(durable.calls).toEqual(["pin"]);
    expect((coder as unknown as { run: ReturnType<typeof vi.fn> }).run).not.toHaveBeenCalled();
  });

  it("refuses profile resolution with a store that cannot pin", () => {
    const full = store(null);
    const legacy: ExecutionStore = { getProgress: full.getProgress, markSourcePrepared: full.markSourcePrepared, markCodingStarted: full.markCodingStarted, saveCost: full.saveCost, saveSafeCodingOutput: full.saveSafeCodingOutput, saveVerification: full.saveVerification };
    expect(() => new ProductExecutionOrchestrator({ store: legacy, sourceProvider: { prepare: async () => baseSource }, codingRunner: {} as ProductCodingRunner, verificationSandboxProvider: {} as SandboxProvider, patchLimits: { maxFiles: 1, maxBytes: 1 }, resolveProfile: () => profile() })).toThrow(/pin/);
  });
});

describe("coding task text", () => {
  it("adds pinned guide and command hints, with lint marked advisory", () => {
    const text = codingTaskText(applyExecutionProfile(baseSource, profile()));
    expect(text).toContain("skill typescript-node@1.0.0");
    expect(text).toContain("Work with the repository's existing Node.js package manager");
    expect(text).toContain("- Test: pnpm test");
    expect(text).toContain("- Single test: pnpm test --run <test file>");
    expect(text).toContain("- Lint (advisory only): pnpm lint");
    expect(text.indexOf("Project commands")).toBeLessThan(text.indexOf("Retry should recover"));
    expect(text).toContain("For bug fixes, add a focused regression test");
  });

  it("keeps today's text for a source without a profile", () => {
    const legacy: PreparedExecutionSource = { repository: baseSource.repository, jobType: baseSource.jobType, requirement: baseSource.requirement, plan: baseSource.plan, commands: baseSource.commands, reviewFocus: baseSource.reviewFocus };
    expect(codingTaskText(legacy)).toBe("Retry should recover\n\nApproved plan:\nFix state and add regression coverage\n\nFor bug fixes, add a focused regression test that fails before the fix and passes after it.");
  });

  it("never prints a command the profile does not have", () => {
    const generic = buildExecutionProfile({ report: { stackSkill: "generic", packageManager: null, installCommand: null, testCommand: "make test", buildCommand: null, manifests: [] }, skills, planningSkill: null, sandboxTemplateId: () => "fallback" });
    const text = codingTaskText(applyExecutionProfile(baseSource, generic));
    expect(text).toContain("- Test: make test");
    expect(text).not.toMatch(/Install:|Build:|Lint|Single test|Stack guidance/);
  });
});

type Script = (session: string, command: string) => SandboxCommandResult | undefined;
class Session implements SandboxSession {
  readonly workspacePath = "/workspace/repo";
  readonly baselineCommitSha = "a".repeat(40);
  readonly commands: string[] = [];
  constructor(readonly id: string, private readonly script: Script) {}
  async exec(request: SandboxCommand): Promise<SandboxCommandResult> {
    this.commands.push(request.command);
    if (request.command.startsWith("git hash-object")) return { exitCode: 0, stdout: `${"c".repeat(40)}\n`, stderr: "" };
    if (request.command.startsWith("if test -x")) return { exitCode: 0, stdout: "100644\n", stderr: "" };
    return this.script(this.id, request.command) ?? { exitCode: 0, stdout: "", stderr: "" };
  }
  async readFile(): Promise<string> { return ""; }
  async writeFile(): Promise<void> {}
  async setNetworkPhase(): Promise<void> {}
  async exportPatch(): Promise<SandboxPatch> { return { patch: "", status: "" }; }
  async snapshot(): Promise<SandboxSnapshot> { return { id: `${this.id}-snapshot` }; }
  async destroy(): Promise<void> {}
}
class Provider implements SandboxProvider {
  readonly sessions: Session[] = [];
  readonly templates: (string | undefined)[] = [];
  constructor(private readonly script: Script = () => undefined) {}
  async create(request: SandboxCreateRequest): Promise<SandboxSession> {
    this.templates.push(request.template);
    const session = new Session(this.sessions.length === 0 ? "baseline" : "patched", this.script);
    this.sessions.push(session);
    return session;
  }
}
const verify = (provider: SandboxProvider, source: PreparedExecutionSource) => verifyExecution({ sandboxProvider: provider, taskId: execution.taskId, source, patch, reproductionCommand: null, timeoutMs: 20_000, signal: new AbortController().signal });

describe("profile-driven verification", () => {
  it("runs install, test, build in both sandboxes on the pinned template and never lint", async () => {
    const provider = new Provider();
    await verify(provider, applyExecutionProfile(baseSource, profile()));
    expect(provider.templates).toEqual(["tpl-ts", "tpl-ts"]);
    for (const session of provider.sessions) {
      const relevant = session.commands.filter((command) => command.startsWith("pnpm"));
      expect(relevant).toEqual(["pnpm install --frozen-lockfile", "pnpm test", "pnpm build"]);
    }
  });

  it("treats a patched-only 'Cannot find module' as a code failure, not a setup problem", async () => {
    const provider = new Provider((session, command) => session === "patched" && command === "pnpm test" ? { exitCode: 1, stdout: "", stderr: "Error: Cannot find module './missing.js'" } : undefined);
    const result = await verify(provider, applyExecutionProfile(baseSource, profile()));
    expect(result.complete).toBe(true);
    expect(result.hasNewFailures).toBe(true);
    expect(result.checks.find((check) => check.name === "test")?.status).toBe("failed");
  });

  it("reports a setup problem when the baseline itself cannot run any check", async () => {
    const provider = new Provider((_session, command) => command === "pnpm test" || command === "pnpm build" ? { exitCode: 127, stdout: "", stderr: "sh: vitest: command not found" } : undefined);
    const result = await verify(provider, applyExecutionProfile(baseSource, profile()));
    expect(result.complete).toBe(false);
    expect(result.hasNewFailures).toBe(false);
    expect(result.incompleteReason).toContain(verificationSetupFailureText);
    expect(result.incompleteReason).not.toContain("command not found");
  });

  it("does not turn an environment-looking failure into success", async () => {
    const provider = new Provider((_session, command) => command === "pnpm test" ? { exitCode: 1, stdout: "", stderr: "MODULE_NOT_FOUND" } : undefined);
    const result = await verify(provider, applyExecutionProfile(baseSource, profile()));
    expect(result.checks.find((check) => check.name === "test")?.status).not.toBe("passed");
    expect(result.reproduce.reproduced).toBe(false);
  });

  it("keeps today's behaviour for a source without a profile", async () => {
    const legacy: PreparedExecutionSource = { repository: baseSource.repository, jobType: baseSource.jobType, requirement: baseSource.requirement, plan: baseSource.plan, commands: baseSource.commands, reviewFocus: baseSource.reviewFocus };
    const provider = new Provider((_session, command) => command === "pnpm test" || command === "pnpm build" ? { exitCode: 127, stdout: "", stderr: "command not found" } : undefined);
    const result = await verify(provider, legacy);
    expect(provider.templates).toEqual([undefined, undefined]);
    expect(result.incompleteReason).toBe("No test or build command completed successfully on the approved baseline.");
  });
});

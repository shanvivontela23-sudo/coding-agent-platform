import { beforeAll, describe, expect, it } from "vitest";
import { loadBuiltInStackSkills } from "../src/registry.js";
import { stackPromptContext } from "../src/prompt.js";
import { estimateConservativeTokens, type StackSkill } from "../src/schema.js";

let skills: ReadonlyMap<string, StackSkill>;
beforeAll(async () => { skills = await loadBuiltInStackSkills(); });

const currentReport = {
  stackSkill: "typescript-node",
  stackSkillVersion: "1.0.0",
  stackDisplayName: "TypeScript / Node",
  sandboxTemplateKey: "typescript-node",
  packageManager: "pnpm",
  installCommand: "pnpm install --frozen-lockfile",
  testCommand: "pnpm test",
  buildCommand: "pnpm build",
  commandSources: { install: "repo" as const, test: "repo" as const, build: "repo" as const },
  testRunner: "vitest" as const,
  testSingleCommand: "{test} --run {path}",
  manifests: ["package.json", "pnpm-lock.yaml"],
};

describe("stack prompt context", () => {
  it("separates the clarification display name from the trusted planning guide", () => {
    const context = stackPromptContext(currentReport, skills);
    expect(context.clarificationLabel).toBe("TypeScript / Node");
    expect(context.clarificationLabel).not.toMatch(/pnpm|vitest|install|build|test/i);
    expect(context.trustedGuidePrefix).toContain('id="typescript-node" version="1.0.0"');
    expect(context.trustedGuidePrefix).toContain("Work with the repository's existing Node.js package manager");
    expect(context.trustedGuidePrefix).not.toContain("pnpm install --frozen-lockfile");
    expect(estimateConservativeTokens(context.trustedGuidePrefix)).toBeLessThanOrEqual(1_500);
  });

  it("allows a legacy skill id to use the current trusted guide without inferring command metadata", () => {
    const context = stackPromptContext({ stackSkill: "typescript-node", packageManager: "pnpm", installCommand: "pnpm install --frozen-lockfile", testCommand: "pnpm test", buildCommand: null, manifests: ["package.json", "pnpm-lock.yaml"] }, skills);
    expect(context.clarificationLabel).toBe("TypeScript / Node");
    expect(context.trustedGuidePrefix).toContain('version="1.0.0"');
  });

  it("returns no trusted guide for generic or unknown skill reports", () => {
    const context = stackPromptContext({ stackSkill: "generic", packageManager: null, installCommand: null, testCommand: null, buildCommand: null, manifests: [] }, skills);
    expect(context).toEqual({ clarificationLabel: null, trustedGuidePrefix: "", planningSkillId: null, planningSkillVersion: null });
  });
});

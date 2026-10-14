import { beforeAll, describe, expect, it } from "vitest";
import { loadBuiltInStackSkills } from "../src/registry.js";
import { resolveRepositorySkill, resolveStoredProjectReport, type RepositorySkillEvidence } from "../src/resolution.js";
import type { StackSkill } from "../src/schema.js";

let skills: ReadonlyMap<string, StackSkill>;
beforeAll(async () => { skills = await loadBuiltInStackSkills(); });

function evidence(overrides: Partial<RepositorySkillEvidence> = {}): RepositorySkillEvidence {
  return {
    manifests: ["package.json", "pnpm-lock.yaml"],
    languages: ["TypeScript"],
    packageManager: "pnpm",
    scripts: {},
    dependencies: ["typescript"],
    buildTools: [],
    commands: { install: "pnpm install --frozen-lockfile", test: null, build: null },
    ...overrides,
  };
}

describe("repository stack skill resolution", () => {
  it("detects TypeScript/Node and preserves repository commands over defaults", () => {
    const resolved = resolveRepositorySkill(evidence({
      scripts: { test: "custom-test", build: "custom-build", lint: "custom-lint" },
      dependencies: ["typescript", "vitest"],
      commands: { install: "repo-install", test: "repo-test", build: "repo-build" },
    }), skills);
    expect(resolved).toMatchObject({ skillId: "typescript-node", skillVersion: "1.0.0", displayName: "TypeScript / Node", sandboxTemplateKey: "typescript-node" });
    expect(resolved.commands).toEqual({ install: "repo-install", test: "repo-test", build: "repo-build", lint: "pnpm lint" });
    expect(resolved.commandSources).toEqual({ install: "repo", test: "repo", build: "repo", lint: "skill" });
    expect(resolved.testRunner).toBe("vitest");
    expect(resolved.testSingleCommand).toBe("{test} --run {path}");
  });

  it.each([
    ["vitest", "pnpm exec vitest run"],
    ["jest", "pnpm exec jest"],
    ["mocha", "pnpm exec mocha"],
  ])("selects the %s full and focused commands only from positive runner evidence", (runner, expected) => {
    const resolved = resolveRepositorySkill(evidence({ dependencies: ["typescript", runner] }), skills);
    expect(resolved.testRunner).toBe(runner);
    expect(resolved.commands.test).toBe(expected);
    expect(resolved.commandSources.test).toBe("skill");
    expect(resolved.testSingleCommand).toContain("{path}");
  });

  it("detects node:test from the declared test script", () => {
    const resolved = resolveRepositorySkill(evidence({ scripts: { test: "node --test" }, commands: { install: "pnpm install --frozen-lockfile", test: "pnpm test", build: null } }), skills);
    expect(resolved.testRunner).toBe("node:test");
    expect(resolved.commands.test).toBe("pnpm test");
    expect(resolved.testSingleCommand).toBe("{test} {path}");
  });

  it.each([
    ["ambiguous runners", ["typescript", "vitest", "jest"]],
    ["unknown runner", ["typescript", "ava"]],
  ])("does not select a focused command for %s", (_name, dependencies) => {
    const resolved = resolveRepositorySkill(evidence({ dependencies }), skills);
    expect(resolved.testRunner).toBeNull();
    expect(resolved.testSingleCommand).toBeNull();
  });

  it("does not invent test, build, or lint commands without repository evidence", () => {
    const resolved = resolveRepositorySkill(evidence(), skills);
    expect(resolved.commands).toEqual({ install: "pnpm install --frozen-lockfile", test: null, build: null, lint: null });
    expect(resolved.commandSources).toEqual({ install: "repo" });
  });

  it("falls back to generic when no skill has matching manifest and language evidence", () => {
    const resolved = resolveRepositorySkill(evidence({ manifests: ["go.mod"], languages: ["Go"], packageManager: "go modules", dependencies: [], commands: { install: "go mod download", test: "go test ./...", build: null } }), skills);
    expect(resolved).toMatchObject({ skillId: "generic", skillVersion: null, displayName: null, sandboxTemplateKey: null });
    expect(resolved.commands.test).toBe("go test ./...");
    expect(resolved.commandSources.test).toBe("repo");
  });
});

describe("stored project report compatibility", () => {
  it("preserves legacy commands and skill id without inventing sources or runner metadata", () => {
    const resolved = resolveStoredProjectReport({
      stackSkill: "typescript-node",
      packageManager: "pnpm",
      installCommand: "pnpm install --frozen-lockfile",
      testCommand: "pnpm test",
      buildCommand: null,
      manifests: ["package.json", "pnpm-lock.yaml"],
    }, skills);
    expect(resolved.skillId).toBe("typescript-node");
    expect(resolved.skillVersion).toBe("1.0.0");
    expect(resolved.commands).toEqual({ install: "pnpm install --frozen-lockfile", test: "pnpm test", build: null, lint: null });
    expect(resolved.commandSources).toEqual({});
    expect(resolved.testRunner).toBeNull();
    expect(resolved.testSingleCommand).toBeNull();
  });
});

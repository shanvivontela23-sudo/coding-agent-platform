import { describe, expect, it } from "vitest";
import { taskProjectStack } from "../src/task-database.js";

describe("task project stack summary", () => {
  it("passes only display name and commands to the task page", () => {
    const summary = taskProjectStack({ languages: [{ name: "TypeScript", fileCount: 3, percentage: 100 }], frameworks: [], packageManager: "pnpm", installCommand: "pnpm install --frozen-lockfile", buildCommand: null, testCommand: "pnpm test", stackSkill: "typescript-node", stackDisplayName: "TypeScript / Node", commandSources: { install: "skill", test: "repo" }, manifests: ["package.json"] });
    expect(summary).toEqual({ stackSkill: "typescript-node", stackDisplayName: "TypeScript / Node", installCommand: "pnpm install --frozen-lockfile", testCommand: "pnpm test", buildCommand: null, lintCommand: null, commandSources: { install: "skill", test: "repo" } });
    expect(summary).not.toHaveProperty("manifests");
  });

  it("tolerates a missing or legacy report", () => {
    expect(taskProjectStack(null)).toBeNull();
    expect(taskProjectStack({ languages: [], frameworks: [], packageManager: null, installCommand: null, buildCommand: null, testCommand: null, stackSkill: "generic", manifests: [] })).toEqual({ stackSkill: "generic", installCommand: null, testCommand: null, buildCommand: null, lintCommand: null });
  });
});

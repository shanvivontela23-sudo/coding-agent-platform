import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { genericStackMessage, stackBadgeModel } from "../src/stack-badge.js";

describe("stack skill badge", () => {
  it("labels a TypeScript/Node project and lists each command with where it came from", () => {
    expect(stackBadgeModel({ stackSkill: "typescript-node", stackDisplayName: "TypeScript / Node", installCommand: "pnpm install --frozen-lockfile", testCommand: "pnpm test", buildCommand: null, lintCommand: "pnpm lint", commandSources: { install: "skill", test: "repo", lint: "skill" } })).toEqual({
      kind: "skill",
      label: "Stack: TypeScript / Node",
      commands: [
        { role: "Install", command: "pnpm install --frozen-lockfile", source: "skill" },
        { role: "Test", command: "pnpm test", source: "repo" },
        { role: "Lint (hint only)", command: "pnpm lint", source: "skill" },
      ],
    });
  });

  it("shows the exact fallback copy for generic or unknown skills, never an internal id", () => {
    expect(genericStackMessage).toBe("No stack skill for this project. Dhara will work it out, which may be slower.");
    expect(stackBadgeModel({ stackSkill: "generic", testCommand: "make test", buildCommand: null })).toEqual({ kind: "generic", message: genericStackMessage });
    expect(stackBadgeModel({ stackSkill: "retired-skill", testCommand: null, buildCommand: null })).toEqual({ kind: "generic", message: genericStackMessage });
  });

  it("handles older reports without display names or sources and does not invent sources", () => {
    const model = stackBadgeModel({ stackSkill: "typescript-node", testCommand: "pnpm test", buildCommand: "pnpm build" });
    expect(model).toEqual({ kind: "skill", label: "Stack: TypeScript / Node", commands: [{ role: "Test", command: "pnpm test", source: null }, { role: "Build", command: "pnpm build", source: null }] });
  });

  it("renders the badge on the project and task pages", async () => {
    const project = await readFile("apps/web/app/projects/[projectId]/page.tsx", "utf8");
    const task = await readFile("apps/web/app/tasks/[taskId]/page.tsx", "utf8");
    expect(project).toContain("<StackSkillBadge report={project.report} />");
    expect(task).toContain("<StackSkillBadge report={task.projectStack} />");
  });
});

import { Template } from "e2b";
import { describe, expect, it } from "vitest";
import { stackTemplates } from "../sandbox-templates/build-stack.js";
import { CLAUDE_CODE_VERSION, CODEX_VERSION } from "../sandbox-templates/typescript-node/template.js";
import { loadBuiltInStackSkillsSync } from "../../packages/skills/src/registry.js";
import { sandboxTemplateEnvName } from "../../packages/skills/src/profile.js";

describe("stack sandbox templates", () => {
  const dockerfile = (stack: string) => Template.toDockerfile(stackTemplates[stack]!.template);

  it("defines a template for every non-TypeScript built-in skill, named by its template key", () => {
    const keys = [...loadBuiltInStackSkillsSync().values()].map((skill) => skill.sandboxTemplateKey).filter((key) => key !== "typescript-node").sort();
    expect(Object.keys(stackTemplates).sort()).toEqual(keys);
    for (const [key, entry] of Object.entries(stackTemplates)) expect(entry.envName).toBe(sandboxTemplateEnvName(key));
  });

  it.each(["python", "java", "dotnet"])("puts the pinned coding harness and git in the %s template", (stack) => {
    const file = dockerfile(stack);
    expect(file).toContain(`@openai/codex@${CODEX_VERSION}`);
    expect(file).toContain(`@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}`);
    expect(file).toMatch(/apt-get install -y --no-install-recommends git /);
    expect(file).not.toMatch(/API_KEY|TOKEN|SECRET/i);
  });

  it("installs each stack's toolchain", () => {
    expect(dockerfile("python")).toMatch(/FROM python:3\.12/);
    expect(dockerfile("python")).toMatch(/uv==.*poetry==.*pipenv==/);
    expect(dockerfile("java")).toMatch(/FROM eclipse-temurin:21-jdk/);
    expect(dockerfile("java")).toContain("/usr/local/bin/mvn");
    expect(dockerfile("java")).toContain("/usr/local/bin/gradle");
    expect(dockerfile("dotnet")).toMatch(/FROM mcr\.microsoft\.com\/dotnet\/sdk:8\.0/);
    expect(dockerfile("dotnet")).toContain("--channel 9.0");
  });
});

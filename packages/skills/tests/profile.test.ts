import { beforeAll, describe, expect, it } from "vitest";
import { buildExecutionProfile, focusedTestCommand, parseExecutionProfile, resolveSandboxTemplateId, safeWorkspaceRelativePath, sandboxTemplateEnvName } from "../src/profile.js";
import { loadBuiltInStackSkills } from "../src/registry.js";
import type { StackSkill } from "../src/schema.js";

let skills: ReadonlyMap<string, StackSkill>;
beforeAll(async () => { skills = await loadBuiltInStackSkills(); });

const tsReport = { stackSkill: "typescript-node", stackSkillVersion: "1.0.0", packageManager: "pnpm", installCommand: "pnpm install --frozen-lockfile", testCommand: "pnpm test", buildCommand: null, lintCommand: "pnpm lint", commandSources: { install: "skill", test: "repo", lint: "skill" } as const, testRunner: "vitest" as const, manifests: ["package.json"] };
const genericReport = { stackSkill: "generic", packageManager: null, installCommand: null, testCommand: "make test", buildCommand: null, manifests: [] };

describe("sandbox template selection", () => {
  it("maps a skill key through E2B_TEMPLATE_<KEY> and falls back to E2B_TEMPLATE_ID", () => {
    expect(sandboxTemplateEnvName("typescript-node")).toBe("E2B_TEMPLATE_TYPESCRIPT_NODE");
    expect(resolveSandboxTemplateId("typescript-node", { E2B_TEMPLATE_TYPESCRIPT_NODE: "ts-tpl" }, "fallback")).toBe("ts-tpl");
    expect(resolveSandboxTemplateId("typescript-node", {}, "fallback")).toBe("fallback");
    expect(resolveSandboxTemplateId("typescript-node", { E2B_TEMPLATE_TYPESCRIPT_NODE: "   " }, "fallback")).toBe("fallback");
    expect(resolveSandboxTemplateId(null, { E2B_TEMPLATE_TYPESCRIPT_NODE: "ts-tpl" }, "fallback")).toBe("fallback");
    expect(() => resolveSandboxTemplateId(null, {}, " ")).toThrow(/E2B_TEMPLATE_ID/);
  });
});

describe("execution profile", () => {
  it("pins skill, guide, commands and template for a TypeScript/Node report", () => {
    const keys: (string | null)[] = [];
    const profile = buildExecutionProfile({ report: tsReport, skills, planningSkill: { id: "typescript-node", version: "1.0.0" }, sandboxTemplateId: (key) => { keys.push(key); return "ts-tpl"; } });
    expect(keys).toEqual(["typescript-node"]);
    expect(profile).toMatchObject({ skillId: "typescript-node", skillVersion: "1.0.0", planningSkillVersion: "1.0.0", sandboxTemplateId: "ts-tpl", testRunner: "vitest", testSingleTemplate: "{test} --run {path}" });
    expect(profile.commands).toEqual({ install: "pnpm install --frozen-lockfile", test: "pnpm test", build: null, lint: "pnpm lint" });
    expect(profile.guide).toContain("package manager");
    expect(profile.verification?.map((check) => check.name)).toEqual(["install", "test", "build"]);
    expect(parseExecutionProfile(JSON.parse(JSON.stringify(profile)))).toEqual(profile);
  });

  it("degrades to generic with the fallback template and claims no skill version", () => {
    const profile = buildExecutionProfile({ report: genericReport, skills, planningSkill: null, sandboxTemplateId: (key) => key ?? "fallback" });
    expect(profile).toMatchObject({ skillId: null, skillVersion: null, guide: null, verification: null, testSingleTemplate: null, sandboxTemplateId: "fallback" });
    expect(profile.commands.test).toBe("make test");
  });

  it("treats a report pinned to an unknown skill version as generic but keeps its stored commands", () => {
    const profile = buildExecutionProfile({ report: { ...tsReport, stackSkillVersion: "9.9.9" }, skills, planningSkill: null, sandboxTemplateId: (key) => key ?? "fallback" });
    expect(profile).toMatchObject({ skillId: null, guide: null, sandboxTemplateId: "fallback" });
    expect(profile.commands.test).toBe("pnpm test");
  });

  it("keeps legacy reports without a runner on today's full-test behaviour", () => {
    const profile = buildExecutionProfile({ report: { stackSkill: "typescript-node", packageManager: "pnpm", installCommand: null, testCommand: "pnpm test", buildCommand: "pnpm build", manifests: ["package.json"] }, skills, planningSkill: null, sandboxTemplateId: () => "t" });
    expect(profile.skillId).toBe("typescript-node");
    expect(profile.testSingleTemplate).toBeNull();
    expect(profile.commands).toEqual({ install: null, test: "pnpm test", build: "pnpm build", lint: null });
  });

  it("rejects malformed stored profiles", () => {
    expect(() => parseExecutionProfile({})).toThrow(/invalid/);
    expect(() => parseExecutionProfile({ ...buildExecutionProfile({ report: genericReport, skills, planningSkill: null, sandboxTemplateId: () => "t" }), sandboxTemplateId: "has space" })).toThrow(/invalid/);
  });
});

describe("focused test commands from untrusted patch paths", () => {
  const runners = [
    ["vitest", "{test} --run {path}", "pnpm exec vitest run --run src/a.test.ts"],
    ["jest", "{test} --runTestsByPath {path}", "pnpm exec vitest run --runTestsByPath src/a.test.ts"],
    ["mocha", "{test} {path}", "pnpm exec vitest run src/a.test.ts"],
    ["node:test", "{test} {path}", "pnpm exec vitest run src/a.test.ts"],
  ] as const;
  it.each(runners)("uses the %s template", (_runner, template, expected) => {
    expect(focusedTestCommand({ testCommand: "pnpm exec vitest run", testSingleTemplate: template, path: "src/a.test.ts" })).toBe(expected);
  });

  it("appends the path to the full test command when no runner template is pinned", () => {
    expect(focusedTestCommand({ testCommand: "pnpm test", testSingleTemplate: null, path: "test/a.test.ts" })).toBe("pnpm test test/a.test.ts");
    expect(focusedTestCommand({ testCommand: "npm test", testSingleTemplate: null, path: "test/a.test.ts" })).toBe("npm test -- test/a.test.ts");
    expect(focusedTestCommand({ testCommand: null, testSingleTemplate: null, path: "test/a.test.ts" })).toBeNull();
  });

  it.each(["/etc/passwd", "../outside.test.ts", "src/../../x.test.ts", "src\\..\\x.test.ts", "a\0b.test.ts", "a\nwhoami", "a\rb", "C:/x.test.ts", "--config=evil.js", ""])("rejects hostile path %j", (path) => {
    expect(safeWorkspaceRelativePath(path)).toBeNull();
    expect(focusedTestCommand({ testCommand: "pnpm test", testSingleTemplate: "{test} --run {path}", path })).toBeNull();
  });

  it("quotes spaces, quotes and semicolons as one shell argument and never expands replacement patterns", () => {
    expect(focusedTestCommand({ testCommand: "pnpm test", testSingleTemplate: null, path: "src/my test.ts" })).toBe("pnpm test 'src/my test.ts'");
    expect(focusedTestCommand({ testCommand: "pnpm test", testSingleTemplate: null, path: "src/it's.test.ts" })).toBe(`pnpm test 'src/it'"'"'s.test.ts'`);
    expect(focusedTestCommand({ testCommand: "pnpm test", testSingleTemplate: "{test} --run {path}", path: "a;rm -rf ~.test.ts" })).toBe("pnpm test --run 'a;rm -rf ~.test.ts'");
    expect(focusedTestCommand({ testCommand: "pnpm test", testSingleTemplate: "{test} --run {path}", path: "a$&b.test.ts" })).toBe("pnpm test --run 'a$&b.test.ts'");
    expect(focusedTestCommand({ testCommand: "pnpm test", testSingleTemplate: null, path: "./src/a.test.ts" })).toBe("pnpm test src/a.test.ts");
  });
});

describe("class-based focused tests (JVM and .NET)", () => {
  it("selects the test class from the file name", () => {
    expect(focusedTestCommand({ testCommand: "sh ./mvnw -B test", testSingleTemplate: "{test} -Dtest={class} -Dsurefire.failIfNoSpecifiedTests=false", path: "src/test/java/demo/RefundServiceTest.java" })).toBe("sh ./mvnw -B test -Dtest=RefundServiceTest -Dsurefire.failIfNoSpecifiedTests=false");
    expect(focusedTestCommand({ testCommand: "sh ./gradlew --no-daemon test", testSingleTemplate: "{test} --tests {class}", path: "src/test/kotlin/demo/AppTest.kt" })).toBe("sh ./gradlew --no-daemon test --tests AppTest");
    expect(focusedTestCommand({ testCommand: "dotnet test Demo.sln --no-restore", testSingleTemplate: "{test} --filter FullyQualifiedName~{class}", path: "tests/Demo.Tests/RefundServiceTests.cs" })).toBe("dotnet test Demo.sln --no-restore --filter FullyQualifiedName~RefundServiceTests");
  });

  it("refuses file names that are not plain class identifiers", () => {
    expect(focusedTestCommand({ testCommand: "mvn -B test", testSingleTemplate: "{test} -Dtest={class}", path: "src/test/java/a;b/Evil$Test.java" })).toBeNull();
    expect(focusedTestCommand({ testCommand: "mvn -B test", testSingleTemplate: "{test} -Dtest={class}", path: "src/test/java/My Test.java" })).toBeNull();
    expect(focusedTestCommand({ testCommand: "mvn -B test", testSingleTemplate: "{test} -Dtest={class}", path: "src/test/resources/data.json" })).toBeNull();
    expect(focusedTestCommand({ testCommand: "mvn -B test", testSingleTemplate: "{test} -Dtest={class}", path: "../x/FooTest.java" })).toBeNull();
  });

  it("uses the file path for pytest", () => {
    expect(focusedTestCommand({ testCommand: "python -m pytest", testSingleTemplate: "{test} {path}", path: "tests/test_refunds.py" })).toBe("python -m pytest tests/test_refunds.py");
  });

  it("validates every built-in skill's focused templates", () => {
    for (const skill of skills.values()) for (const template of Object.values(skill.defaults.testSingle)) expect(template).toMatch(/\{(path|class)\}/);
  });
});

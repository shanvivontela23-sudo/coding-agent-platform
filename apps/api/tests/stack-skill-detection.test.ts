import { describe, expect, it } from "vitest";
import { analyseRepositoryEntries } from "../src/repository-analysis.js";

const entry = (path: string, contents = "") => ({ path, bytes: new TextEncoder().encode(contents) });

describe("stack skill detection from repository evidence", () => {
  it("detects a pip + pytest Python project and installs dev requirements", () => {
    const report = analyseRepositoryEntries([
      entry("requirements.txt", "flask==3.0.0\n"),
      entry("requirements-dev.txt", "pytest==8.3.0\n"),
      entry("app/refunds.py"), entry("tests/test_refunds.py"),
    ]);
    expect(report).toMatchObject({ stackSkill: "python", stackDisplayName: "Python", sandboxTemplateKey: "python", testRunner: "pytest", testSingleCommand: "{test} {path}" });
    expect(report.installCommand).toBe("python -m pip install -r requirements.txt -r requirements-dev.txt");
    expect(report.testCommand).toBe("python -m pytest");
    expect(report.commandSources).toMatchObject({ install: "repo", test: "repo" });
  });

  it("runs pytest through uv when uv manages the virtualenv", () => {
    const report = analyseRepositoryEntries([
      entry("pyproject.toml", "[project]\nname = 'demo'\n[dependency-groups]\ndev = [\"pytest>=8\"]\n"),
      entry("uv.lock", "version = 1\n"), entry("src/demo/__init__.py"),
    ]);
    expect(report).toMatchObject({ stackSkill: "python", testRunner: "pytest", installCommand: "uv sync --frozen", testCommand: "uv run pytest" });
  });

  it("does not invent a Python test command without pytest evidence", () => {
    const report = analyseRepositoryEntries([entry("requirements.txt", "requests==2.32.0\n"), entry("main.py")]);
    expect(report.stackSkill).toBe("python");
    expect(report.testRunner).toBeNull();
    expect(report.testCommand).toBeNull();
  });

  it("detects a Maven wrapper Spring project and selects tests by class", () => {
    const report = analyseRepositoryEntries([
      entry("pom.xml", "<project><dependencies><dependency><artifactId>spring-boot-starter-web</artifactId></dependency><dependency><artifactId>junit-jupiter</artifactId></dependency></dependencies></project>"),
      entry("mvnw", "#!/bin/sh\n"),
      entry("src/main/java/demo/RefundService.java"), entry("src/test/java/demo/RefundServiceTest.java"),
    ]);
    expect(report).toMatchObject({ stackSkill: "java-spring", stackDisplayName: "Java / Spring", sandboxTemplateKey: "java", testRunner: "maven-surefire" });
    expect(report.frameworks).toContain("Spring Boot");
    expect(report.installCommand).toBe("sh ./mvnw -B -q dependency:go-offline test -Dmaven.test.failure.ignore=true");
    expect(report.testCommand).toBe("sh ./mvnw -B test");
    expect(report.buildCommand).toBe("sh ./mvnw -B -DskipTests package");
    expect(report.testSingleCommand).toBe("{test} -Dtest={class} -Dsurefire.failIfNoSpecifiedTests=false");
  });

  it("detects a Gradle Kotlin project", () => {
    const report = analyseRepositoryEntries([
      entry("build.gradle.kts", "dependencies { testImplementation(\"org.junit.jupiter:junit-jupiter:5.10.0\") }"),
      entry("src/main/kotlin/demo/App.kt"),
    ]);
    expect(report).toMatchObject({ stackSkill: "java-spring", testRunner: "gradle-test", testCommand: "gradle --no-daemon test", buildCommand: "gradle --no-daemon assemble" });
  });

  it("picks the stack with the most source files and lists the others", () => {
    const report = analyseRepositoryEntries([
      entry("pom.xml", "<project></project>"),
      entry("src/main/java/a/A.java"), entry("src/main/java/a/B.java"), entry("src/main/java/a/C.java"),
      entry("web/package.json", JSON.stringify({ scripts: { test: "vitest" }, devDependencies: { vitest: "3.0.0" } })),
      entry("web/src/app.ts"),
    ]);
    expect(report.stackSkill).toBe("java-spring");
    expect(report.otherStacks).toEqual(["TypeScript / Node"]);
  });

  it("keeps TypeScript projects on the TypeScript skill", () => {
    const report = analyseRepositoryEntries([
      entry("package.json", JSON.stringify({ scripts: { test: "vitest" }, devDependencies: { vitest: "3.0.0", typescript: "5.0.0" } })),
      entry("pnpm-lock.yaml", "lockfileVersion: '9.0'"), entry("src/a.ts"), entry("src/b.ts"), entry("scripts/tool.py"),
    ]);
    expect(report).toMatchObject({ stackSkill: "typescript-node", stackSkillVersion: "1.0.0", testRunner: "vitest" });
  });
});

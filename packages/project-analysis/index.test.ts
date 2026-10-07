import { describe, expect, it } from "vitest";
import { analysisManifestPaths, analyzeProject, type RepositorySnapshot } from "./index.js";

function snapshot(paths: readonly string[], files: Record<string, string>): RepositorySnapshot {
  return { tree: paths.map((path) => ({ path, type: "blob" as const })), files };
}

describe("deterministic project analysis", () => {
  it("detects a pnpm Next.js TypeScript project and ignores generated files", () => {
    const input = snapshot([
      "src/index.ts",
      "src/view.tsx",
      "src/legacy.js",
      "dist/generated.js",
      "node_modules/pkg/index.js",
      "package.json",
      "pnpm-lock.yaml",
    ], {
      "package.json": JSON.stringify({
        scripts: { build: "next build", test: "vitest run" },
        dependencies: { next: "16.4.0", react: "19.0.0" },
      }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    });
    expect(analyzeProject(input)).toEqual({
      languages: [
        { language: "TypeScript", files: 2, share: 2 / 3 },
        { language: "JavaScript", files: 1, share: 1 / 3 },
      ],
      frameworks: ["Next.js", "React"],
      packageManager: "pnpm",
      buildCommand: "pnpm run build",
      testCommand: "pnpm test",
      stackSkill: "typescript-node",
    });
  });

  it("detects Python FastAPI with uv and pytest without inventing a build command", () => {
    const input = snapshot(["app/main.py", "tests/test_app.py", "pyproject.toml", "uv.lock"], {
      "pyproject.toml": "[project]\ndependencies = [\"fastapi\", \"pytest\"]\n",
      "uv.lock": "version = 1\n",
    });
    expect(analyzeProject(input)).toMatchObject({
      languages: [{ language: "Python", files: 2, share: 1 }],
      frameworks: ["FastAPI"],
      packageManager: "uv",
      buildCommand: null,
      testCommand: "uv run pytest",
      stackSkill: "python",
    });
  });

  it("detects Spring Maven and .NET web projects from deterministic manifest evidence", () => {
    const spring = snapshot(["src/main/java/App.java", "pom.xml", "mvnw"], {
      "pom.xml": "<project><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency></project>",
    });
    expect(analyzeProject(spring)).toMatchObject({ frameworks: ["Spring"], packageManager: "Maven", buildCommand: "./mvnw package", testCommand: "./mvnw test", stackSkill: "java-spring" });

    const dotnet = snapshot(["src/App.cs", "App.csproj"], {
      "App.csproj": "<Project Sdk=\"Microsoft.NET.Sdk.Web\"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>",
    });
    expect(analyzeProject(dotnet)).toMatchObject({ frameworks: ["ASP.NET Core"], packageManager: "NuGet", buildCommand: "dotnet build", testCommand: "dotnet test", stackSkill: "dotnet" });
  });

  it("uses a stable generic fallback and deterministic language ordering", () => {
    const input = snapshot(["cmd/main.go", "pkg/a.go", "native/a.rs", "README.md"], {});
    expect(analyzeProject(input)).toEqual({
      languages: [
        { language: "Go", files: 2, share: 2 / 3 },
        { language: "Rust", files: 1, share: 1 / 3 },
      ],
      frameworks: [],
      packageManager: null,
      buildCommand: null,
      testCommand: null,
      stackSkill: "generic",
    });
  });

  it("chooses package-manager lockfiles deterministically and exposes only analysis manifests", () => {
    const input = snapshot(["package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "src/index.ts", "secrets.txt"], {
      "package.json": JSON.stringify({ scripts: { test: "node --test" } }),
      "package-lock.json": "{}",
      "yarn.lock": "",
      "pnpm-lock.yaml": "",
    });
    expect(analyzeProject(input).packageManager).toBe("pnpm");
    expect(analysisManifestPaths(input.tree)).toEqual(["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"]);
  });
});

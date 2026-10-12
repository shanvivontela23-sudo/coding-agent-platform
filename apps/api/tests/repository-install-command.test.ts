import { describe, expect, it } from "vitest";
import { analyseRepositoryEntries } from "../src/repository-analysis.js";

const entry = (path: string, contents = "") => ({ path, bytes: new TextEncoder().encode(contents) });

describe("project report install commands", () => {
  it("records install commands for detected JavaScript, Python, Java, and Go stacks", () => {
    expect(analyseRepositoryEntries([
      entry("package.json", JSON.stringify({ scripts: { test: "vitest" } })),
      entry("pnpm-lock.yaml", "lockfileVersion: '9.0'"),
      entry("src/app.ts", ""),
    ]).installCommand).toBe("pnpm install --frozen-lockfile");

    expect(analyseRepositoryEntries([
      entry("requirements.txt", "pytest==9.0.0\n"),
      entry("app.py", ""),
    ]).installCommand).toBe("python -m pip install -r requirements.txt");

    expect(analyseRepositoryEntries([
      entry("pyproject.toml", "[project]\nname='demo'\n"),
      entry("uv.lock", "version = 1\n"),
      entry("app.py", ""),
    ]).installCommand).toBe("uv sync --frozen");

    expect(analyseRepositoryEntries([
      entry("pyproject.toml", "[tool.poetry]\nname='demo'\n"),
      entry("poetry.lock", ""),
      entry("app.py", ""),
    ]).installCommand).toBe("poetry install --no-interaction");

    expect(analyseRepositoryEntries([
      entry("pom.xml", "<project></project>"),
      entry("src/main/java/App.java", ""),
    ]).installCommand).toBe("mvn -q -DskipTests dependency:go-offline");

    expect(analyseRepositoryEntries([
      entry("build.gradle", "plugins {}"),
      entry("gradlew", ""),
      entry("src/main/java/App.java", ""),
    ]).installCommand).toBe("./gradlew dependencies");

    expect(analyseRepositoryEntries([
      entry("go.mod", "module example.com/demo\n"),
      entry("main.go", ""),
    ]).installCommand).toBe("go mod download");
  });

  it("records no install command for an unknown stack", () => {
    expect(analyseRepositoryEntries([entry("README.txt", "hello")]).installCommand).toBeNull();
  });
});

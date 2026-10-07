export type StackSkill = "typescript-node" | "python" | "java-spring" | "dotnet" | "generic";

export type RepositoryTreeEntry = {
  readonly path: string;
  readonly type: "blob" | "tree";
  readonly size?: number;
};

export type RepositorySnapshot = {
  readonly tree: readonly RepositoryTreeEntry[];
  readonly files: Readonly<Record<string, string>>;
};

export type LanguageShare = {
  readonly language: string;
  readonly files: number;
  readonly share: number;
};

export type ProjectReport = {
  readonly languages: readonly LanguageShare[];
  readonly frameworks: readonly string[];
  readonly packageManager: string | null;
  readonly buildCommand: string | null;
  readonly testCommand: string | null;
  readonly stackSkill: StackSkill;
};

const languageByExtension: Readonly<Record<string, string>> = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".mts": "TypeScript",
  ".cts": "TypeScript",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".mjs": "JavaScript",
  ".cjs": "JavaScript",
  ".py": "Python",
  ".java": "Java",
  ".kt": "Kotlin",
  ".kts": "Kotlin",
  ".cs": "C#",
  ".go": "Go",
  ".rs": "Rust",
  ".rb": "Ruby",
  ".php": "PHP",
  ".swift": "Swift",
  ".c": "C",
  ".cc": "C++",
  ".cpp": "C++",
  ".cxx": "C++",
  ".h": "C/C++ Header",
  ".hpp": "C/C++ Header",
  ".scala": "Scala",
  ".sh": "Shell",
};

const ignoredSegments = new Set([
  ".git",
  ".next",
  ".nuxt",
  ".cache",
  ".pytest_cache",
  ".venv",
  "venv",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "vendor",
  "target",
  "bin",
  "obj",
]);

const manifestNames = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "pyproject.toml",
  "requirements.txt",
  "requirements-dev.txt",
  "poetry.lock",
  "uv.lock",
  "Pipfile",
  "Pipfile.lock",
  "pom.xml",
  "mvnw",
  "build.gradle",
  "build.gradle.kts",
  "gradlew",
  "global.json",
]);

const manifestPriority: Readonly<Record<string, number>> = {
  "package.json": 10,
  "package-lock.json": 20,
  "npm-shrinkwrap.json": 21,
  "pnpm-lock.yaml": 30,
  "yarn.lock": 40,
};

function basename(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function extension(path: string): string {
  const name = basename(path);
  const index = name.lastIndexOf(".");
  return index <= 0 ? "" : name.slice(index).toLowerCase();
}

function ignored(path: string): boolean {
  return path.split("/").some((segment) => ignoredSegments.has(segment));
}

function fileText(snapshot: RepositorySnapshot, name: string): string | undefined {
  return snapshot.files[name] ?? Object.entries(snapshot.files).find(([path]) => basename(path) === name)?.[1];
}

function containsAny(haystack: string, needles: readonly string[]): boolean {
  const lower = haystack.toLowerCase();
  return needles.some((needle) => lower.includes(needle.toLowerCase()));
}

function parsePackageJson(snapshot: RepositorySnapshot): Record<string, unknown> | null {
  const text = fileText(snapshot, "package.json");
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function stringRecord(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function detectNode(snapshot: RepositorySnapshot) {
  const packageJson = parsePackageJson(snapshot);
  if (!packageJson) return null;
  const scripts = stringRecord(packageJson.scripts);
  const dependencies = { ...stringRecord(packageJson.dependencies), ...stringRecord(packageJson.devDependencies) };
  const names = new Set(Object.keys(dependencies));
  const frameworks: string[] = [];
  if (names.has("next")) frameworks.push("Next.js");
  if (names.has("react")) frameworks.push("React");
  if (names.has("express")) frameworks.push("Express");
  if (names.has("fastify")) frameworks.push("Fastify");
  if (names.has("@nestjs/core")) frameworks.push("NestJS");

  const paths = new Set(snapshot.tree.filter((entry) => entry.type === "blob").map((entry) => basename(entry.path)));
  const packageManager = paths.has("pnpm-lock.yaml") ? "pnpm" : paths.has("yarn.lock") ? "yarn" : (paths.has("package-lock.json") || paths.has("npm-shrinkwrap.json")) ? "npm" : null;
  const runner = packageManager ?? "npm";
  return {
    frameworks,
    packageManager,
    buildCommand: typeof scripts.build === "string" ? `${runner} run build` : null,
    testCommand: typeof scripts.test === "string" ? `${runner} test` : null,
  };
}

function detectPython(snapshot: RepositorySnapshot) {
  const names = new Set(snapshot.tree.filter((entry) => entry.type === "blob").map((entry) => basename(entry.path)));
  const evidence = [fileText(snapshot, "pyproject.toml"), fileText(snapshot, "requirements.txt"), fileText(snapshot, "requirements-dev.txt"), fileText(snapshot, "Pipfile")].filter((value): value is string => typeof value === "string").join("\n");
  const hasPython = names.has("pyproject.toml") || names.has("requirements.txt") || snapshot.tree.some((entry) => extension(entry.path) === ".py");
  if (!hasPython) return null;
  const frameworks: string[] = [];
  if (containsAny(evidence, ["fastapi"])) frameworks.push("FastAPI");
  if (containsAny(evidence, ["django"])) frameworks.push("Django");
  if (containsAny(evidence, ["flask"])) frameworks.push("Flask");
  const packageManager = names.has("uv.lock") ? "uv" : names.has("poetry.lock") ? "Poetry" : (names.has("requirements.txt") || names.has("pyproject.toml")) ? "pip" : null;
  const hasPytest = containsAny(evidence, ["pytest"]);
  return {
    frameworks,
    packageManager,
    buildCommand: null,
    testCommand: hasPytest ? (packageManager === "uv" ? "uv run pytest" : packageManager === "Poetry" ? "poetry run pytest" : "pytest") : null,
  };
}

function detectJava(snapshot: RepositorySnapshot) {
  const names = new Set(snapshot.tree.filter((entry) => entry.type === "blob").map((entry) => basename(entry.path)));
  const pom = fileText(snapshot, "pom.xml") ?? "";
  const gradle = `${fileText(snapshot, "build.gradle") ?? ""}\n${fileText(snapshot, "build.gradle.kts") ?? ""}`;
  if (!names.has("pom.xml") && !names.has("build.gradle") && !names.has("build.gradle.kts")) return null;
  const spring = containsAny(`${pom}\n${gradle}`, ["spring-boot", "org.springframework"]);
  if (names.has("pom.xml")) {
    const command = names.has("mvnw") ? "./mvnw" : "mvn";
    return { frameworks: spring ? ["Spring"] : [], packageManager: "Maven", buildCommand: `${command} package`, testCommand: `${command} test`, spring };
  }
  const command = names.has("gradlew") ? "./gradlew" : "gradle";
  return { frameworks: spring ? ["Spring"] : [], packageManager: "Gradle", buildCommand: `${command} build`, testCommand: `${command} test`, spring };
}

function detectDotNet(snapshot: RepositorySnapshot) {
  const projectPath = snapshot.tree.find((entry) => entry.type === "blob" && entry.path.toLowerCase().endsWith(".csproj"))?.path;
  if (!projectPath) return null;
  const content = snapshot.files[projectPath] ?? fileText(snapshot, basename(projectPath)) ?? "";
  const web = containsAny(content, ["Microsoft.NET.Sdk.Web"]);
  return { frameworks: web ? ["ASP.NET Core"] : [".NET"], packageManager: "NuGet", buildCommand: "dotnet build", testCommand: "dotnet test" };
}

export function analysisManifestPaths(tree: readonly RepositoryTreeEntry[]): string[] {
  return tree
    .filter((entry) => entry.type === "blob" && !ignored(entry.path))
    .map((entry) => entry.path)
    .filter((path) => {
      const name = basename(path);
      return manifestNames.has(name) || path.toLowerCase().endsWith(".csproj") || path.toLowerCase().endsWith(".sln");
    })
    .sort((left, right) => {
      const leftName = basename(left);
      const rightName = basename(right);
      const leftPriority = manifestPriority[leftName] ?? 100;
      const rightPriority = manifestPriority[rightName] ?? 100;
      return leftPriority - rightPriority || left.localeCompare(right);
    });
}

export function analyzeProject(snapshot: RepositorySnapshot): ProjectReport {
  const counts = new Map<string, number>();
  for (const entry of snapshot.tree) {
    if (entry.type !== "blob" || ignored(entry.path)) continue;
    const language = languageByExtension[extension(entry.path)];
    if (language) counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  const total = [...counts.values()].reduce((sum, value) => sum + value, 0);
  const languages = [...counts.entries()]
    .map(([language, files]) => ({ language, files, share: total === 0 ? 0 : files / total }))
    .sort((a, b) => b.files - a.files || a.language.localeCompare(b.language));

  const node = detectNode(snapshot);
  const python = detectPython(snapshot);
  const java = detectJava(snapshot);
  const dotnet = detectDotNet(snapshot);

  if (node) return { languages, frameworks: [...node.frameworks].sort(), packageManager: node.packageManager, buildCommand: node.buildCommand, testCommand: node.testCommand, stackSkill: "typescript-node" };
  if (java?.spring) return { languages, frameworks: [...java.frameworks].sort(), packageManager: java.packageManager, buildCommand: java.buildCommand, testCommand: java.testCommand, stackSkill: "java-spring" };
  if (dotnet) return { languages, frameworks: [...dotnet.frameworks].sort(), packageManager: dotnet.packageManager, buildCommand: dotnet.buildCommand, testCommand: dotnet.testCommand, stackSkill: "dotnet" };
  if (python) return { languages, frameworks: [...python.frameworks].sort(), packageManager: python.packageManager, buildCommand: python.buildCommand, testCommand: python.testCommand, stackSkill: "python" };
  return { languages, frameworks: [], packageManager: null, buildCommand: null, testCommand: null, stackSkill: "generic" };
}

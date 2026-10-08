import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";

export type RepositoryAnalysisLimits = {
  readonly maxCompressedBytes: number;
  readonly maxUncompressedBytes: number;
  readonly maxFiles: number;
  readonly maxFileBytes: number;
};

export type WorkspaceCommand = {
  readonly name: string;
  readonly path: string;
  readonly buildCommand: string | null;
  readonly testCommand: string | null;
};

export type ProjectReport = {
  readonly languages: ReadonlyArray<{ readonly name: string; readonly fileCount: number; readonly percentage: number }>;
  readonly frameworks: readonly string[];
  readonly packageManager: string | null;
  readonly buildCommand: string | null;
  readonly testCommand: string | null;
  readonly workspaceCommands?: readonly WorkspaceCommand[];
  readonly stackSkill: "typescript-node" | "generic";
  readonly manifests: readonly string[];
};

export type RepositoryAnalysisEntry = { readonly path: string; readonly bytes: Uint8Array };

export class RepositoryAnalysisError extends Error {
  readonly code: "REPOSITORY_TOO_LARGE" | "REPOSITORY_INVALID_ARCHIVE";
  readonly publicMessage: string;
  constructor(code: RepositoryAnalysisError["code"], publicMessage: string) {
    super(publicMessage);
    this.name = "RepositoryAnalysisError";
    this.code = code;
    this.publicMessage = publicMessage;
  }
}

const tooLarge = () => new RepositoryAnalysisError("REPOSITORY_TOO_LARGE", "Repository too large to analyse.");
const invalidArchive = () => new RepositoryAnalysisError("REPOSITORY_INVALID_ARCHIVE", "Repository archive could not be analysed.");

const languageByExtension: Readonly<Record<string, string>> = {
  ".c": "C", ".cc": "C++", ".cpp": "C++", ".cxx": "C++", ".cs": "C#", ".dart": "Dart", ".go": "Go",
  ".java": "Java", ".js": "JavaScript", ".jsx": "JavaScript", ".cjs": "JavaScript", ".mjs": "JavaScript",
  ".kt": "Kotlin", ".kts": "Kotlin", ".php": "PHP", ".py": "Python", ".rb": "Ruby", ".rs": "Rust",
  ".scala": "Scala", ".sh": "Shell", ".svelte": "Svelte", ".swift": "Swift", ".ts": "TypeScript",
  ".tsx": "TypeScript", ".vue": "Vue",
};
const recognizedManifestNames = new Set([
  "package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml", "yarn.lock", "package-lock.json", "bun.lock", "bun.lockb", "pyproject.toml",
  "requirements.txt", "poetry.lock", "uv.lock", "Pipfile", "Pipfile.lock", "pom.xml", "build.gradle",
  "build.gradle.kts", "gradlew", "go.mod", "Cargo.toml", "Gemfile",
]);
const generatedSegments = new Set([".git", ".next", ".venv", "build", "coverage", "dist", "node_modules", "obj", "target", "vendor", "venv"]);

type SeenManifest = { readonly name: string; readonly path: string; readonly directory: string; readonly depth: number; readonly contents: string };
type TarHeader = { readonly name: string; readonly size: number; readonly type: string };
type PackageInfo = {
  readonly manifest: SeenManifest;
  readonly name: string;
  readonly dependencies: ReadonlySet<string>;
  readonly scripts: ReadonlySet<string>;
  readonly hasTypescript: boolean;
  readonly workspacePatterns: readonly string[];
};

function nulTerminated(buffer: Buffer<ArrayBufferLike>): string {
  const zero = buffer.indexOf(0);
  return buffer.subarray(0, zero < 0 ? buffer.length : zero).toString("utf8");
}
function parseOctal(buffer: Buffer<ArrayBufferLike>): number {
  const text = nulTerminated(buffer).trim().replace(/^\0+/, "");
  if (!text) return 0;
  if (!/^[0-7]+$/.test(text)) throw invalidArchive();
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw invalidArchive();
  return value;
}
function parseHeader(header: Buffer<ArrayBufferLike>): TarHeader | null {
  if (header.length !== 512) throw invalidArchive();
  if (header.every((value) => value === 0)) return null;
  const name = nulTerminated(header.subarray(0, 100));
  const prefix = nulTerminated(header.subarray(345, 500));
  return { name: prefix ? `${prefix}/${name}` : name, size: parseOctal(header.subarray(124, 136)), type: String.fromCharCode(header[156] ?? 0) };
}
function parsePaxPath(buffer: Buffer<ArrayBufferLike>): string | null {
  let offset = 0;
  let path: string | null = null;
  while (offset < buffer.length) {
    const space = buffer.indexOf(32, offset);
    if (space < 0) throw invalidArchive();
    const lengthText = buffer.subarray(offset, space).toString("ascii");
    if (!/^[1-9][0-9]*$/.test(lengthText)) throw invalidArchive();
    const length = Number.parseInt(lengthText, 10);
    if (!Number.isSafeInteger(length) || length <= space - offset + 1 || offset + length > buffer.length) throw invalidArchive();
    const record = buffer.subarray(space + 1, offset + length);
    if (record.at(-1) !== 10) throw invalidArchive();
    const body = record.subarray(0, -1).toString("utf8");
    const equals = body.indexOf("=");
    if (equals <= 0) throw invalidArchive();
    if (body.slice(0, equals) === "path") path = body.slice(equals + 1);
    offset += length;
  }
  return path;
}
function safeArchivePath(path: string): boolean {
  return Boolean(path) && !path.startsWith("/") && !path.startsWith("\\") && !/^[A-Za-z]:[\\/]/.test(path) && !path.includes("..") && !path.includes("\0");
}
function withoutArchiveRoot(path: string): string {
  const parts = path.replaceAll("\\", "/").replace(/^\.\//, "").split("/").filter(Boolean);
  return parts.length > 1 ? parts.slice(1).join("/") : parts[0] ?? "";
}
function basename(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}
function dirname(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const slash = normalized.lastIndexOf("/");
  return slash < 0 ? "" : normalized.slice(0, slash);
}
function pathDepth(path: string): number { return path ? path.split("/").filter(Boolean).length : 0; }
function extension(path: string): string {
  const name = basename(path).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot) : "";
}
function pathSegments(path: string): string[] { return path.split("/").filter(Boolean).map((segment) => segment.toLowerCase()); }
function countableLanguagePath(path: string): boolean { return !pathSegments(path).some((segment) => generatedSegments.has(segment)); }
function frameworkManifestPathAllowed(path: string): boolean { return !pathSegments(dirname(path)).some((segment) => generatedSegments.has(segment)); }
function isRecognizedManifest(name: string): boolean {
  const lower = name.toLowerCase();
  return recognizedManifestNames.has(name) || lower.endsWith(".csproj") || lower.endsWith(".sln");
}
function analysisRelevantPath(path: string): boolean {
  const name = basename(path);
  return isRecognizedManifest(name) || (countableLanguagePath(path) && Boolean(languageByExtension[extension(path)]));
}
function sourceInSubtree(sourcePaths: ReadonlyMap<string, readonly string[]>, languages: readonly string[], directory: string): boolean {
  for (const language of languages) for (const path of sourcePaths.get(language) ?? []) if (!directory || path.startsWith(`${directory}/`)) return true;
  return false;
}
function commandForScript(manager: string | null, script: "build" | "test"): string {
  if (manager === "pnpm") return `pnpm ${script}`;
  if (manager === "yarn") return `yarn ${script}`;
  if (manager === "bun") return script === "test" ? "bun test" : "bun run build";
  return script === "test" ? "npm test" : "npm run build";
}
function detectPackageManager(names: ReadonlySet<string>): string | null {
  if (names.has("pnpm-lock.yaml")) return "pnpm";
  if (names.has("yarn.lock")) return "yarn";
  if (names.has("bun.lock") || names.has("bun.lockb")) return "bun";
  if (names.has("package-lock.json")) return "npm";
  if (names.has("uv.lock")) return "uv";
  if (names.has("poetry.lock")) return "poetry";
  if (names.has("Pipfile.lock") || names.has("Pipfile")) return "pipenv";
  if (names.has("go.mod")) return "go modules";
  if (names.has("Cargo.toml")) return "cargo";
  return names.has("package.json") ? "npm" : null;
}
function workspacePatterns(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "object" && value !== null && !Array.isArray(value) && Array.isArray((value as Record<string, unknown>).packages) ? (value as Record<string, unknown>).packages as unknown[] : [];
  return raw.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}
function packageInfo(manifest: SeenManifest): PackageInfo | null {
  try {
    const parsed = JSON.parse(manifest.contents) as Record<string, unknown>; const dependencies = new Set<string>();
    for (const key of ["dependencies", "devDependencies", "peerDependencies"] as const) {
      const section = parsed[key]; if (typeof section !== "object" || section === null || Array.isArray(section)) continue;
      for (const dependency of Object.keys(section as Record<string, unknown>)) dependencies.add(dependency);
    }
    const scripts = new Set<string>(); if (typeof parsed.scripts === "object" && parsed.scripts !== null && !Array.isArray(parsed.scripts)) for (const script of Object.keys(parsed.scripts as Record<string, unknown>)) scripts.add(script);
    const name = typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : manifest.directory || "package";
    return { manifest, name, dependencies, scripts, hasTypescript: dependencies.has("typescript"), workspacePatterns: workspacePatterns(parsed.workspaces) };
  } catch { return null; }
}
function parsePackageJson(manifests: readonly SeenManifest[]) {
  const packages = manifests.filter((manifest) => manifest.name === "package.json").sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path)).map(packageInfo).filter((item): item is PackageInfo => item !== null);
  return { packages, root: packages.find((item) => item.manifest.path === "package.json") ?? packages[0] ?? null, hasTypescript: packages.some((item) => item.hasTypescript) };
}
function detectFrameworks(manifests: readonly SeenManifest[], packages: readonly PackageInfo[], sourcePaths: ReadonlyMap<string, readonly string[]>): string[] {
  const found = new Set<string>();
  const dependencyMap: ReadonlyArray<readonly [string, string, readonly string[]]> = [
    ["next", "Next.js", ["TypeScript", "JavaScript"]], ["react", "React", ["TypeScript", "JavaScript"]], ["vite", "Vite", ["TypeScript", "JavaScript"]],
    ["express", "Express", ["TypeScript", "JavaScript"]], ["fastify", "Fastify", ["TypeScript", "JavaScript"]], ["@nestjs/core", "NestJS", ["TypeScript", "JavaScript"]],
    ["@angular/core", "Angular", ["TypeScript", "JavaScript"]], ["vue", "Vue", ["TypeScript", "JavaScript", "Vue"]], ["svelte", "Svelte", ["TypeScript", "JavaScript", "Svelte"]],
  ];
  for (const pkg of packages) {
    if (!frameworkManifestPathAllowed(pkg.manifest.path)) continue;
    for (const [dependency, framework, languages] of dependencyMap) if (pkg.dependencies.has(dependency) && sourceInSubtree(sourcePaths, languages, pkg.manifest.directory)) found.add(framework);
  }
  for (const manifest of manifests) {
    if (!frameworkManifestPathAllowed(manifest.path)) continue;
    const lower = manifest.contents.toLowerCase();
    if ((manifest.name === "pyproject.toml" || manifest.name === "requirements.txt") && sourceInSubtree(sourcePaths, ["Python"], manifest.directory)) {
      if (/(^|[^a-z])django([^a-z]|$)/m.test(lower)) found.add("Django");
      if (/(^|[^a-z])fastapi([^a-z]|$)/m.test(lower)) found.add("FastAPI");
      if (/(^|[^a-z])flask([^a-z]|$)/m.test(lower)) found.add("Flask");
    }
    if ((manifest.name === "pom.xml" || manifest.name.startsWith("build.gradle")) && sourceInSubtree(sourcePaths, ["Java", "Kotlin"], manifest.directory) && lower.includes("spring-boot")) found.add("Spring Boot");
    if (manifest.name === "Gemfile" && sourceInSubtree(sourcePaths, ["Ruby"], manifest.directory) && /(^|\s)gem\s+["']rails["']/.test(lower)) found.add("Rails");
  }
  return [...found].sort((a, b) => a.localeCompare(b));
}
function detectCommands(manifests: readonly SeenManifest[], manager: string | null, rootPackage: PackageInfo | null) {
  if (rootPackage) {
    const buildCommand = rootPackage.scripts.has("build") ? commandForScript(manager, "build") : null; const testCommand = rootPackage.scripts.has("test") ? commandForScript(manager, "test") : null;
    if (buildCommand || testCommand) return { buildCommand, testCommand };
  }
  const solution = manifests.filter((manifest) => manifest.name.toLowerCase().endsWith(".sln")).sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path))[0];
  if (solution) return { buildCommand: `dotnet build ${solution.path}`, testCommand: `dotnet test ${solution.path}` };
  const project = manifests.filter((manifest) => manifest.name.toLowerCase().endsWith(".csproj")).sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path))[0];
  if (project) return { buildCommand: `dotnet build ${project.path}`, testCommand: `dotnet test ${project.path}` };
  const names = new Set(manifests.map((manifest) => manifest.name));
  if (names.has("pom.xml")) return { buildCommand: "mvn package", testCommand: "mvn test" };
  if (names.has("build.gradle") || names.has("build.gradle.kts")) return { buildCommand: names.has("gradlew") ? "./gradlew build" : "gradle build", testCommand: names.has("gradlew") ? "./gradlew test" : "gradle test" };
  if (names.has("go.mod")) return { buildCommand: "go build ./...", testCommand: "go test ./..." };
  if (names.has("Cargo.toml")) return { buildCommand: "cargo build", testCommand: "cargo test" };
  const python = manifests.find((manifest) => manifest.name === "pyproject.toml" || manifest.name === "requirements.txt");
  if (python) { const lower = python.contents.toLowerCase(); return { buildCommand: names.has("pyproject.toml") && lower.includes("[build-system]") ? "python -m build" : null, testCommand: lower.includes("pytest") ? "pytest" : null }; }
  return { buildCommand: null, testCommand: null };
}
function parsePnpmWorkspacePatterns(manifests: readonly SeenManifest[]): string[] {
  const root = manifests.find((manifest) => manifest.path === "pnpm-workspace.yaml"); if (!root) return [];
  const patterns: string[] = [];
  for (const line of root.contents.split(/\r?\n/)) {
    const match = line.match(/^\s*-\s*["']?([^"']+?)["']?\s*$/); if (match?.[1] && !match[1].startsWith("!")) patterns.push(match[1].trim());
  }
  return patterns;
}
function globRegex(pattern: string): RegExp {
  const normalized = pattern.replace(/^\.\//, "").replace(/\/$/, ""); let regex = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index] ?? "";
    if (char === "*" && normalized[index + 1] === "*") { regex += ".*"; index += 1; continue; }
    if (char === "*") { regex += "[^/]*"; continue; }
    if (char === "?") { regex += "[^/]"; continue; }
    regex += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${regex}$`);
}
function detectWorkspaceCommands(packageData: ReturnType<typeof parsePackageJson>, manifests: readonly SeenManifest[], manager: string | null): WorkspaceCommand[] {
  const root = packageData.packages.find((item) => item.manifest.path === "package.json"); if (!root) return [];
  const patterns = [...root.workspacePatterns, ...parsePnpmWorkspacePatterns(manifests)]; if (patterns.length === 0) return [];
  const matchers = patterns.map(globRegex);
  return packageData.packages.filter((pkg) => pkg !== root && matchers.some((matcher) => matcher.test(pkg.manifest.directory))).map((pkg) => ({ name: pkg.name, path: pkg.manifest.directory, buildCommand: pkg.scripts.has("build") ? commandForScript(manager, "build") : null, testCommand: pkg.scripts.has("test") ? commandForScript(manager, "test") : null })).filter((workspace) => workspace.buildCommand !== null || workspace.testCommand !== null).sort((a, b) => a.path.localeCompare(b.path));
}

export function analyseRepositoryEntries(entries: readonly RepositoryAnalysisEntry[]): ProjectReport {
  const languageCounts = new Map<string, number>(); const sourcePaths = new Map<string, string[]>(); const manifests: SeenManifest[] = []; const manifestNames = new Set<string>();
  for (const entry of entries) {
    const path = entry.path.replaceAll("\\", "/").replace(/^\.\//, "");
    if (!safeArchivePath(path)) continue;
    const name = basename(path);
    if (isRecognizedManifest(name)) { manifests.push({ name, path, directory: dirname(path), depth: pathDepth(path), contents: Buffer.from(entry.bytes).toString("utf8") }); manifestNames.add(name); }
    if (countableLanguagePath(path)) {
      const language = languageByExtension[extension(path)];
      if (language) { languageCounts.set(language, (languageCounts.get(language) ?? 0) + 1); const paths = sourcePaths.get(language) ?? []; paths.push(path); sourcePaths.set(language, paths); }
    }
  }
  const totalLanguageFiles = [...languageCounts.values()].reduce((sum, count) => sum + count, 0);
  const languages = [...languageCounts.entries()].map(([name, count]) => ({ name, fileCount: count, percentage: totalLanguageFiles === 0 ? 0 : Math.round((count / totalLanguageFiles) * 10_000) / 100 })).sort((a, b) => b.fileCount - a.fileCount || a.name.localeCompare(b.name));
  const packageData = parsePackageJson(manifests); const packageManager = detectPackageManager(manifestNames); const frameworks = detectFrameworks(manifests, packageData.packages, sourcePaths); const commands = detectCommands(manifests, packageManager, packageData.root); const workspaceCommands = detectWorkspaceCommands(packageData, manifests, packageManager); const stackSkill: ProjectReport["stackSkill"] = manifestNames.has("package.json") && (packageData.hasTypescript || languageCounts.has("TypeScript") || languageCounts.has("JavaScript")) ? "typescript-node" : "generic";
  return { languages, frameworks, packageManager, buildCommand: commands.buildCommand, testCommand: commands.testCommand, workspaceCommands, stackSkill, manifests: [...manifestNames] };
}

export async function readRepositoryAnalysisEntries(input: Uint8Array, limits: RepositoryAnalysisLimits): Promise<readonly RepositoryAnalysisEntry[]> {
  if (input.byteLength > limits.maxCompressedBytes) throw tooLarge();
  const source = Readable.from([Buffer.from(input)]); const gunzip = createGunzip(); source.pipe(gunzip);
  let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0); let uncompressedBytes = 0; let current: TarHeader | null = null; let currentPath: string | null = null; let dataRemaining = 0; let paddingRemaining = 0; let capture: Array<Buffer<ArrayBufferLike>> | null = null; let captureKind: "manifest" | "source" | "pax" | null = null; let nextPaxPath: string | null = null; let entryCount = 0; let ended = false;
  const entries: RepositoryAnalysisEntry[] = [];
  const finishEntry = () => {
    if (!current) return;
    if (capture && captureKind === "pax") nextPaxPath = parsePaxPath(Buffer.concat(capture));
    else if (capture && captureKind === "manifest" && currentPath) entries.push({ path: currentPath, bytes: Buffer.concat(capture) });
    else if (captureKind === "source" && currentPath) entries.push({ path: currentPath, bytes: new Uint8Array(0) });
    current = null; currentPath = null; capture = null; captureKind = null;
  };
  try {
    for await (const raw of gunzip) {
      const chunk: Buffer<ArrayBufferLike> = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array); uncompressedBytes += chunk.length; if (uncompressedBytes > limits.maxUncompressedBytes) throw tooLarge(); pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length > 0 && !ended) {
        if (!current) {
          if (paddingRemaining > 0) { const consumePadding = Math.min(paddingRemaining, pending.length); pending = pending.subarray(consumePadding); paddingRemaining -= consumePadding; if (paddingRemaining > 0) break; }
          if (pending.length < 512) break;
          const header = parseHeader(pending.subarray(0, 512)); pending = pending.subarray(512); if (!header) { ended = true; break; }
          entryCount += 1; if (entryCount > limits.maxFiles || header.size > limits.maxFileBytes) throw tooLarge(); current = header; dataRemaining = header.size; paddingRemaining = (512 - (header.size % 512)) % 512;
          if (header.type === "x") { capture = []; captureKind = "pax"; }
          else {
            const resolvedPath = nextPaxPath ?? header.name; nextPaxPath = null; const regular = header.type === "0" || header.type === "\0";
            if (regular && safeArchivePath(resolvedPath)) {
              const relative = withoutArchiveRoot(resolvedPath);
              if (analysisRelevantPath(relative)) {
                currentPath = relative;
                if (isRecognizedManifest(basename(relative))) { capture = []; captureKind = "manifest"; }
                else captureKind = "source";
              }
            }
          }
          if (dataRemaining === 0) finishEntry(); continue;
        }
        if (dataRemaining > 0) { const consumed = Math.min(dataRemaining, pending.length); if (capture && consumed > 0) capture.push(Buffer.from(pending.subarray(0, consumed))); pending = pending.subarray(consumed); dataRemaining -= consumed; if (dataRemaining > 0) break; finishEntry(); continue; }
        finishEntry();
      }
    }
  } catch (error) {
    source.destroy(); gunzip.destroy(); if (error instanceof RepositoryAnalysisError) throw error; throw invalidArchive();
  } finally { source.destroy(); gunzip.destroy(); pending = Buffer.alloc(0); capture = null; currentPath = null; nextPaxPath = null; }
  if (!ended && (current !== null || pending.length > 0 || paddingRemaining > 0)) throw invalidArchive();
  return entries;
}

export async function analyseRepositoryArchive(input: Uint8Array, limits: RepositoryAnalysisLimits): Promise<ProjectReport> {
  return analyseRepositoryEntries(await readRepositoryAnalysisEntries(input, limits));
}

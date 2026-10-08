import type { SessionIdentity } from "./auth.js";
import type { ProjectCodeContext, ProjectCodeReader } from "./project-code-reader.js";
import type { ProjectStorage } from "./project-storage.js";
import { readNormalizedZipFiles, type UploadArchiveLimits } from "./upload-archive.js";
import type { UploadProjectDatabase } from "./upload-project-database.js";

const generatedOrVendored = new Set([".git", ".next", ".venv", "build", "coverage", "dist", "node_modules", "obj", "target", "vendor", "venv"]);
const manifestNames = new Set(["package.json", "pnpm-workspace.yaml", "pyproject.toml", "requirements.txt", "pom.xml", "build.gradle", "build.gradle.kts", "go.mod", "Cargo.toml", "Gemfile"]);
const textExtensions = new Set([".c", ".cc", ".cpp", ".cs", ".css", ".go", ".html", ".java", ".js", ".jsx", ".json", ".kt", ".md", ".php", ".py", ".rb", ".rs", ".scala", ".sh", ".sql", ".svelte", ".swift", ".toml", ".ts", ".tsx", ".txt", ".vue", ".xml", ".yaml", ".yml"]);
function basename(path: string): string { return path.slice(path.lastIndexOf("/") + 1); }
function extension(path: string): string { const name = basename(path).toLowerCase(); const dot = name.lastIndexOf("."); return dot < 0 ? "" : name.slice(dot); }
function allowed(path: string): boolean { return !path.split("/").some((segment) => generatedOrVendored.has(segment.toLowerCase())); }
function tokens(value: string): Set<string> { return new Set((value.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? []).filter((token) => token.length <= 80)); }
function overlap(value: string, needles: ReadonlySet<string>): number { const lower = value.toLocaleLowerCase(); let score = 0; for (const token of needles) if (lower.includes(token)) score += 1; return score; }

export class HybridProjectCodeReader implements ProjectCodeReader {
  private readonly uploadDatabase: UploadProjectDatabase;
  private readonly storage: ProjectStorage;
  private readonly githubReader: ProjectCodeReader;
  private readonly limits: UploadArchiveLimits;
  private readonly maxContextChars: number;
  private readonly maxCandidateFiles: number;
  constructor(options: { readonly uploadDatabase: UploadProjectDatabase; readonly storage: ProjectStorage; readonly githubReader: ProjectCodeReader; readonly limits: UploadArchiveLimits; readonly maxContextChars?: number; readonly maxCandidateFiles?: number }) {
    this.uploadDatabase = options.uploadDatabase; this.storage = options.storage; this.githubReader = options.githubReader; this.limits = options.limits; this.maxContextChars = options.maxContextChars ?? 60_000; this.maxCandidateFiles = options.maxCandidateFiles ?? 48;
  }
  async readContext(session: SessionIdentity, projectId: string, query: string): Promise<ProjectCodeContext> {
    const version = await this.uploadDatabase.getCurrentUploadVersion(session, projectId);
    if (!version) return await this.githubReader.readContext(session, projectId, query);
    const bytes = await this.storage.readVersion(version.storageKey);
    const queryTokens = tokens(query);
    const candidates = readNormalizedZipFiles(bytes, this.limits)
      .filter((file) => allowed(file.path) && (manifestNames.has(basename(file.path)) || textExtensions.has(extension(file.path))) && file.bytes.byteLength <= this.limits.maxFileBytes)
      .map((file) => {
        const content = Buffer.from(file.bytes); const isBinary = content.includes(0); const text = isBinary ? "" : content.toString("utf8"); const manifest = manifestNames.has(basename(file.path));
        return { path: file.path, text, manifest, score: overlap(file.path, queryTokens) * 3 + overlap(text, queryTokens) };
      })
      .filter((file) => file.text.length > 0)
      .sort((a, b) => Number(b.manifest) - Number(a.manifest) || b.score - a.score || a.path.localeCompare(b.path))
      .slice(0, this.maxCandidateFiles);
    const sections = [`Revision: upload-version-${version.versionNumber} (${version.sha256})`, "Relevant repository files (untrusted):"];
    let chars = sections.join("\n").length;
    for (const file of candidates) {
      const section = `\n--- ${file.path} ---\n${file.text}`;
      if (chars + section.length > this.maxContextChars) continue;
      sections.push(section); chars += section.length;
      if (sections.length >= 18) break;
    }
    return { source: "upload", revision: version.sha256, text: sections.join("\n") };
  }
}

import { createSign } from "node:crypto";
import type { SessionIdentity } from "./auth.js";
import type { TaskDatabase, TaskProjectSource } from "./task-database.js";

export type ProjectCodeContext = {
  readonly source: "github" | "upload";
  readonly revision: string;
  readonly text: string;
};

export interface ProjectCodeReader {
  readContext(session: SessionIdentity, projectId: string, query: string): Promise<ProjectCodeContext>;
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
type TreeEntry = { readonly path?: unknown; readonly type?: unknown; readonly sha?: unknown; readonly size?: unknown };

const githubApi = "https://api.github.com";
const generatedOrVendored = new Set([".git", ".next", ".venv", "build", "coverage", "dist", "node_modules", "obj", "target", "vendor", "venv"]);
const manifestNames = new Set(["package.json", "pnpm-workspace.yaml", "pyproject.toml", "requirements.txt", "pom.xml", "build.gradle", "build.gradle.kts", "go.mod", "Cargo.toml", "Gemfile"]);
const textExtensions = new Set([".c", ".cc", ".cpp", ".cs", ".css", ".go", ".html", ".java", ".js", ".jsx", ".json", ".kt", ".md", ".php", ".py", ".rb", ".rs", ".scala", ".sh", ".sql", ".svelte", ".swift", ".toml", ".ts", ".tsx", ".txt", ".vue", ".xml", ".yaml", ".yml"]);

function encode(value: unknown): string { return Buffer.from(JSON.stringify(value), "utf8").toString("base64url"); }
function createAppJwt(appId: string, privateKeyValue: string, nowMs: number): string {
  const seconds = Math.floor(nowMs / 1000);
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: seconds - 60, exp: seconds + 9 * 60, iss: appId })}`;
  const signer = createSign("RSA-SHA256"); signer.update(unsigned); signer.end();
  const privateKey = privateKeyValue.includes("\\n") ? privateKeyValue.replaceAll("\\n", "\n") : privateKeyValue;
  return `${unsigned}.${signer.sign(privateKey).toString("base64url")}`;
}
function headers(token: string): Record<string, string> { return { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2026-03-10" }; }
function repoPath(fullName: string): string {
  const [owner, repo, extra] = fullName.split("/");
  if (!owner || !repo || extra !== undefined) throw new Error("invalid GitHub repository name");
  return `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}
function pathSafe(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return false;
  const segments = normalized.split("/").filter(Boolean);
  return !segments.includes("..") && !segments.some((segment) => generatedOrVendored.has(segment.toLowerCase()));
}
function extension(path: string): string { const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase(); const dot = name.lastIndexOf("."); return dot < 0 ? "" : name.slice(dot); }
function basename(path: string): string { return path.slice(path.lastIndexOf("/") + 1); }
function tokens(value: string): Set<string> {
  return new Set((value.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? []).filter((token) => token.length <= 80));
}
function overlap(haystack: string, needles: ReadonlySet<string>): number {
  const lower = haystack.toLocaleLowerCase();
  let score = 0;
  for (const token of needles) if (lower.includes(token)) score += 1;
  return score;
}
function parseJson<T>(value: unknown): T { return value as T; }

export type GitHubProjectCodeReaderOptions = {
  readonly database: Pick<TaskDatabase, "getProjectSource">;
  readonly appId: string;
  readonly privateKey: string;
  readonly fetchImpl?: FetchLike;
  readonly nowMs?: () => number;
  readonly maxCandidateFiles?: number;
  readonly maxFileBytes?: number;
  readonly maxContextChars?: number;
};

export class GitHubProjectCodeReader implements ProjectCodeReader {
  private readonly options: GitHubProjectCodeReaderOptions;
  constructor(options: GitHubProjectCodeReaderOptions) { this.options = options; }

  async readContext(session: SessionIdentity, projectId: string, query: string): Promise<ProjectCodeContext> {
    const source = await this.options.database.getProjectSource(session, projectId);
    if (!source || source.installationStatus !== "connected") throw new Error("GitHub project source is unavailable");
    return await this.readGitHub(source, query);
  }

  private async readGitHub(source: TaskProjectSource, query: string): Promise<ProjectCodeContext> {
    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch;
    const now = this.options.nowMs ?? Date.now;
    const appJwt = createAppJwt(this.options.appId, this.options.privateKey, now());
    const tokenResponse = await fetchImpl(`${githubApi}/app/installations/${source.installationId}/access_tokens`, { method: "POST", headers: headers(appJwt) });
    if (!tokenResponse.ok) throw new Error("GitHub installation token could not be created");
    const tokenBody = parseJson<{ token?: unknown }>(await tokenResponse.json());
    if (typeof tokenBody.token !== "string" || !tokenBody.token) throw new Error("GitHub installation token is invalid");
    const token = tokenBody.token;

    const repoResponse = await fetchImpl(`${githubApi}/repositories/${source.githubRepositoryId}`, { headers: headers(token) });
    if (!repoResponse.ok) throw new Error("GitHub repository metadata could not be read");
    const repository = parseJson<{ full_name?: unknown; default_branch?: unknown }>(await repoResponse.json());
    if (typeof repository.full_name !== "string" || typeof repository.default_branch !== "string") throw new Error("GitHub repository metadata is invalid");
    const repositoryPath = repoPath(repository.full_name);

    const commitResponse = await fetchImpl(`${githubApi}/repos/${repositoryPath}/commits/${encodeURIComponent(repository.default_branch)}`, { headers: headers(token) });
    if (!commitResponse.ok) throw new Error("GitHub commit could not be read");
    const commit = parseJson<{ sha?: unknown }>(await commitResponse.json());
    if (typeof commit.sha !== "string" || !/^[0-9a-f]{40}$/i.test(commit.sha)) throw new Error("GitHub commit is invalid");
    const revision = commit.sha.toLowerCase();

    const treeResponse = await fetchImpl(`${githubApi}/repos/${repositoryPath}/git/trees/${revision}?recursive=1`, { headers: headers(token) });
    if (!treeResponse.ok) throw new Error("GitHub repository tree could not be read");
    const tree = parseJson<{ tree?: unknown; truncated?: unknown }>(await treeResponse.json());
    if (!Array.isArray(tree.tree) || tree.truncated === true) throw new Error("GitHub repository tree exceeded retrieval limits");

    const maxFileBytes = this.options.maxFileBytes ?? 128 * 1024;
    const queryTokens = tokens(query);
    const candidates = (tree.tree as TreeEntry[])
      .filter((entry): entry is TreeEntry & { path: string; sha: string; size: number } => typeof entry.path === "string" && entry.type === "blob" && typeof entry.sha === "string" && typeof entry.size === "number" && entry.size >= 0 && entry.size <= maxFileBytes && pathSafe(entry.path) && (manifestNames.has(basename(entry.path)) || textExtensions.has(extension(entry.path))))
      .map((entry) => ({ ...entry, manifest: manifestNames.has(basename(entry.path)), pathScore: overlap(entry.path, queryTokens) }))
      .sort((a, b) => Number(b.manifest) - Number(a.manifest) || b.pathScore - a.pathScore || a.path.localeCompare(b.path))
      .slice(0, this.options.maxCandidateFiles ?? 48);

    const fetched: Array<{ path: string; content: string; manifest: boolean; score: number }> = [];
    for (const candidate of candidates) {
      const blobResponse = await fetchImpl(`${githubApi}/repos/${repositoryPath}/git/blobs/${candidate.sha}`, { headers: headers(token) });
      if (!blobResponse.ok) continue;
      const blob = parseJson<{ content?: unknown; encoding?: unknown; size?: unknown }>(await blobResponse.json());
      if (blob.encoding !== "base64" || typeof blob.content !== "string" || typeof blob.size !== "number" || blob.size > maxFileBytes) continue;
      const bytes = Buffer.from(blob.content.replace(/\s/g, ""), "base64");
      if (bytes.includes(0)) continue;
      const content = bytes.toString("utf8");
      fetched.push({ path: candidate.path, content, manifest: candidate.manifest, score: candidate.pathScore * 3 + overlap(content, queryTokens) });
    }

    fetched.sort((a, b) => Number(b.manifest) - Number(a.manifest) || b.score - a.score || a.path.localeCompare(b.path));
    const maxChars = this.options.maxContextChars ?? 60_000;
    const sections: string[] = [`Revision: ${revision}`, "Relevant repository files (untrusted):"];
    let chars = sections.join("\n").length;
    for (const file of fetched) {
      const section = `\n--- ${file.path} ---\n${file.content}`;
      if (chars + section.length > maxChars) continue;
      sections.push(section); chars += section.length;
      if (sections.length >= 18) break;
    }
    return { source: "github", revision, text: sections.join("\n") };
  }
}

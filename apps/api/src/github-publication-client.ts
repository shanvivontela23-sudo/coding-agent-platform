import { createSign } from "node:crypto";
import { parsePatchFiles } from "../../worker/src/patch-parser.js";
import type { GitHubPublicationClient } from "./github-publication.js";

function base64urlJson(value: unknown): string { return Buffer.from(JSON.stringify(value), "utf8").toString("base64url"); }
function appJwt(appId: string, privateKey: string, nowMs: number): string {
  const seconds = Math.floor(nowMs / 1000);
  const header = base64urlJson({ alg: "RS256", typ: "JWT" });
  const payload = base64urlJson({ iat: seconds - 60, exp: seconds + 9 * 60, iss: appId });
  const unsigned = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256"); signer.update(unsigned); signer.end();
  const key = privateKey.includes("\\n") ? privateKey.replaceAll("\\n", "\n") : privateKey;
  return `${unsigned}.${signer.sign(key).toString("base64url")}`;
}
function repoParts(fullName: string): readonly [string, string] {
  const match = fullName.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!match) throw new Error("GitHub repository full name is invalid");
  return [match[1]!, match[2]!];
}
async function jsonObject(response: Response): Promise<Record<string, unknown>> {
  const value = await response.json() as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("GitHub response was not an object");
  return value as Record<string, unknown>;
}
function stringField(value: unknown, name: string): string { if (typeof value !== "string" || !value) throw new Error(`GitHub response missing ${name}`); return value; }
function numberField(value: unknown, name: string): number { if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`GitHub response missing ${name}`); return value; }

function applyUnifiedFilePatch(source: string, rawPatch: string): string {
  if (/^GIT binary patch$/m.test(rawPatch) || /^Binary files /m.test(rawPatch)) throw new Error("Binary patches cannot be published automatically");
  const sourceTrailingNewline = source.endsWith("\n");
  const sourceLines = source.length === 0 ? [] : source.replace(/\n$/, "").split("\n");
  const output: string[] = [];
  let cursor = 0;
  const lines = rawPatch.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const header = lines[index]!.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!header) continue;
    const oldStart = Number(header[1]);
    const oldCount = header[2] === undefined ? 1 : Number(header[2]);
    const hunkStart = oldCount === 0 ? oldStart : Math.max(0, oldStart - 1);
    if (hunkStart < cursor || hunkStart > sourceLines.length) throw new Error("Patch hunk does not match approved source");
    output.push(...sourceLines.slice(cursor, hunkStart));
    cursor = hunkStart;
    index += 1;
    for (; index < lines.length && !lines[index]!.startsWith("@@ "); index += 1) {
      const line = lines[index]!;
      if (line.startsWith("diff --git ")) { index -= 1; break; }
      if (line.startsWith("\\ No newline at end of file") || line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("index ") || line.startsWith("new file mode ") || line.startsWith("deleted file mode ")) continue;
      const marker = line[0];
      const text = line.slice(1);
      if (marker === " ") {
        if (sourceLines[cursor] !== text) throw new Error("Patch context does not match approved source");
        output.push(text); cursor += 1;
      } else if (marker === "-") {
        if (sourceLines[cursor] !== text) throw new Error("Patch removal does not match approved source");
        cursor += 1;
      } else if (marker === "+") output.push(text);
      else if (line.length > 0) throw new Error("Unsupported patch line");
    }
    index -= 1;
  }
  output.push(...sourceLines.slice(cursor));
  const joined = output.join("\n");
  const patchDeclaresNoNewline = /\\ No newline at end of file\s*$/.test(rawPatch.trimEnd());
  return joined && !patchDeclaresNoNewline && (sourceTrailingNewline || /\n\+[^\n]*\n?$/.test(rawPatch)) ? `${joined}\n` : joined;
}

type TreeEntry = { readonly path: string; readonly mode: string; readonly type: string; readonly sha: string };

export class GitHubRestPublicationClient implements GitHubPublicationClient {
  private readonly fetchImpl: typeof fetch;
  private readonly apiVersion: string;
  constructor(private readonly options: { readonly appId: string; readonly privateKey: string; readonly fetchImpl?: typeof fetch; readonly apiVersion?: string; readonly nowMs?: () => number; readonly createAppJwt?: () => string }) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.apiVersion = options.apiVersion ?? "2026-03-10";
  }
  private async request(fullName: string, path: string, init: RequestInit = {}): Promise<Response> {
    const [owner, repo] = repoParts(fullName);
    const jwt = this.options.createAppJwt?.() ?? appJwt(this.options.appId, this.options.privateKey, (this.options.nowMs ?? Date.now)());
    const installation = await this.fetchImpl(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`, { headers: { accept: "application/vnd.github+json", authorization: `Bearer ${jwt}`, "x-github-api-version": this.apiVersion } });
    if (!installation.ok) throw new Error(`GitHub installation lookup failed (${installation.status})`);
    const installationBody = await jsonObject(installation);
    const installationId = numberField(installationBody.id, "installation id");
    const tokenResponse = await this.fetchImpl(`https://api.github.com/app/installations/${installationId}/access_tokens`, { method: "POST", headers: { accept: "application/vnd.github+json", authorization: `Bearer ${jwt}`, "x-github-api-version": this.apiVersion } });
    if (!tokenResponse.ok) throw new Error(`GitHub installation token request failed (${tokenResponse.status})`);
    const token = stringField((await jsonObject(tokenResponse)).token, "installation token");
    const headers = new Headers(init.headers);
    headers.set("accept", "application/vnd.github+json"); headers.set("authorization", `Bearer ${token}`); headers.set("x-github-api-version", this.apiVersion);
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    return await this.fetchImpl(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${path}`, { ...init, headers });
  }
  private async api(fullName: string, path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const response = await this.request(fullName, path, init);
    if (!response.ok) throw new Error(`GitHub publication request failed (${response.status})`);
    return await jsonObject(response);
  }
  async getDefaultBranchHead(input: { repositoryFullName: string; defaultBranch: string }) {
    const body = await this.api(input.repositoryFullName, `/git/ref/heads/${encodeURIComponent(input.defaultBranch)}`);
    const object = body.object as Record<string, unknown> | undefined;
    return { sha: stringField(object?.sha, "ref sha") };
  }
  async compareCommits(input: { repositoryFullName: string; baseSha: string; headSha: string }) {
    const body = await this.api(input.repositoryFullName, `/compare/${input.baseSha}...${input.headSha}`);
    const files = Array.isArray(body.files) ? body.files.map((item) => typeof item === "object" && item !== null ? (item as Record<string, unknown>).filename : null).filter((value): value is string => typeof value === "string") : [];
    const aheadBy = typeof body.ahead_by === "number" && Number.isSafeInteger(body.ahead_by) ? body.ahead_by : 0;
    return { aheadBy, files };
  }
  async ensurePatchedBranch(input: { repositoryFullName: string; branchName: string; approvedSha: string; patch: string }) {
    const commit = await this.api(input.repositoryFullName, `/git/commits/${input.approvedSha}`);
    const commitTree = commit.tree as Record<string, unknown> | undefined;
    const baseTreeSha = stringField(commitTree?.sha, "commit tree sha");
    const treeBody = await this.api(input.repositoryFullName, `/git/trees/${baseTreeSha}?recursive=1`);
    const baseEntries = new Map<string, TreeEntry>();
    if (Array.isArray(treeBody.tree)) for (const value of treeBody.tree) {
      if (!value || typeof value !== "object") continue;
      const entry = value as Record<string, unknown>;
      if (typeof entry.path === "string" && typeof entry.mode === "string" && typeof entry.type === "string" && typeof entry.sha === "string") baseEntries.set(entry.path, { path: entry.path, mode: entry.mode, type: entry.type, sha: entry.sha });
    }
    const entries: Array<{ path: string; mode: string; type: "blob"; sha: string | null }> = [];
    for (const file of parsePatchFiles(input.patch)) {
      const path = file.newPath ?? file.oldPath;
      if (!path) continue;
      if (file.newPath === null) { entries.push({ path, mode: baseEntries.get(path)?.mode ?? "100644", type: "blob", sha: null }); continue; }
      let source = "";
      if (file.oldPath) {
        const oldEntry = baseEntries.get(file.oldPath);
        if (!oldEntry || oldEntry.type !== "blob") throw new Error(`Approved source file is unavailable: ${file.oldPath}`);
        const blob = await this.api(input.repositoryFullName, `/git/blobs/${oldEntry.sha}`);
        const content = stringField(blob.content, "blob content").replace(/\n/g, "");
        source = Buffer.from(content, stringField(blob.encoding, "blob encoding") === "base64" ? "base64" : "utf8").toString("utf8");
      }
      const next = applyUnifiedFilePatch(source, file.raw);
      const blob = await this.api(input.repositoryFullName, "/git/blobs", { method: "POST", body: JSON.stringify({ content: next, encoding: "utf-8" }) });
      entries.push({ path: file.newPath, mode: baseEntries.get(file.oldPath ?? "")?.mode ?? "100644", type: "blob", sha: stringField(blob.sha, "blob sha") });
      if (file.oldPath && file.oldPath !== file.newPath) entries.push({ path: file.oldPath, mode: baseEntries.get(file.oldPath)?.mode ?? "100644", type: "blob", sha: null });
    }
    const createdTree = await this.api(input.repositoryFullName, "/git/trees", { method: "POST", body: JSON.stringify({ base_tree: baseTreeSha, tree: entries }) });
    const expectedTreeSha = stringField(createdTree.sha, "tree sha");
    const createdCommit = await this.api(input.repositoryFullName, "/git/commits", { method: "POST", body: JSON.stringify({ message: `Dhara implementation ${input.branchName.split("-").at(-1) ?? ""}`, tree: expectedTreeSha, parents: [input.approvedSha] }) });
    const desiredCommitSha = stringField(createdCommit.sha, "commit sha");
    const refPath = `/git/ref/heads/${input.branchName.split("/").map(encodeURIComponent).join("/")}`;
    let currentSha: string | null = null;
    const currentResponse = await this.request(input.repositoryFullName, refPath);
    if (currentResponse.status === 404) {
      await this.api(input.repositoryFullName, "/git/refs", { method: "POST", body: JSON.stringify({ ref: `refs/heads/${input.branchName}`, sha: input.approvedSha }) });
      currentSha = input.approvedSha;
    } else if (currentResponse.ok) {
      const current = await jsonObject(currentResponse); const object = current.object as Record<string, unknown> | undefined; currentSha = stringField(object?.sha, "branch sha");
    } else throw new Error(`GitHub branch lookup failed (${currentResponse.status})`);
    if (currentSha === desiredCommitSha) return { headSha: desiredCommitSha };
    if (currentSha !== input.approvedSha) {
      const existingCommit = await this.api(input.repositoryFullName, `/git/commits/${currentSha}`);
      const existingTree = existingCommit.tree as Record<string, unknown> | undefined;
      if (existingTree?.sha === expectedTreeSha) return { headSha: currentSha };
      throw new Error("Deterministic publication branch exists with unexpected content; refusing to force-push");
    }
    await this.api(input.repositoryFullName, `/git/refs/heads/${input.branchName.split("/").map(encodeURIComponent).join("/")}`, { method: "PATCH", body: JSON.stringify({ sha: desiredCommitSha, force: false }) });
    return { headSha: desiredCommitSha };
  }
  async findOpenPullRequest(input: { repositoryFullName: string; branchName: string; baseBranch: string }) {
    const [owner] = repoParts(input.repositoryFullName);
    const response = await this.request(input.repositoryFullName, `/pulls?state=open&head=${encodeURIComponent(`${owner}:${input.branchName}`)}&base=${encodeURIComponent(input.baseBranch)}&per_page=10`);
    if (!response.ok) throw new Error(`GitHub pull request lookup failed (${response.status})`);
    const body = await response.json() as unknown;
    if (!Array.isArray(body) || body.length === 0) return null;
    const first = body[0] as Record<string, unknown>;
    return { number: numberField(first.number, "pull request number"), url: stringField(first.html_url, "pull request URL") };
  }
  async createPullRequest(input: { repositoryFullName: string; branchName: string; baseBranch: string; title: string; body: string }) {
    const body = await this.api(input.repositoryFullName, "/pulls", { method: "POST", body: JSON.stringify({ title: input.title, head: input.branchName, base: input.baseBranch, body: input.body }) });
    return { number: numberField(body.number, "pull request number"), url: stringField(body.html_url, "pull request URL") };
  }
}

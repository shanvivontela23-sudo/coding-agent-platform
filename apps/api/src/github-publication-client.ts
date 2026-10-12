import { createHash, createSign } from "node:crypto";
import { AppError } from "./errors.js";
import { parsePatchFiles } from "../../worker/src/patch-parser.js";
import type { VerifiedFile } from "../../worker/src/verification.js";
import type { GitHubPublicationClient, GitHubPublicationOperation } from "./github-publication.js";

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
function mismatch(message: string): never { throw new AppError("PUBLISHED_CONTENT_MISMATCH", message, 409); }
function gitBlobSha(content: Uint8Array): string {
  const header = Buffer.from(`blob ${content.byteLength}\0`, "utf8");
  return createHash("sha1").update(header).update(content).digest("hex");
}
function splitBufferLines(content: Buffer): Buffer[] {
  const lines: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === 0x0a) { lines.push(content.subarray(start, index + 1)); start = index + 1; }
  }
  if (start < content.length) lines.push(content.subarray(start));
  return lines;
}
type PatchEncoding = "utf8" | "latin1";
type HunkOp = { readonly marker: " " | "+" | "-"; readonly text: string; noNewline: boolean };
function lineBytes(op: HunkOp, encoding: PatchEncoding): Buffer {
  const content = Buffer.from(op.text, encoding);
  return op.noNewline ? content : Buffer.concat([content, Buffer.from("\n")]);
}
function parseHunkOps(lines: readonly string[], start: number): { readonly ops: HunkOp[]; readonly next: number } {
  const ops: HunkOp[] = [];
  let index = start;
  for (; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.startsWith("@@ ") || line.startsWith("diff --git ")) break;
    if (line === "\\ No newline at end of file") {
      const previous = ops.at(-1);
      if (!previous) throw new Error("No-newline marker has no preceding patch line");
      previous.noNewline = true;
      continue;
    }
    const marker = line[0];
    if (marker === " " || marker === "+" || marker === "-") ops.push({ marker, text: line.slice(1), noNewline: false });
    else if (line.length > 0 && !line.startsWith("index ") && !line.startsWith("--- ") && !line.startsWith("+++ ") && !line.startsWith("old mode ") && !line.startsWith("new mode ") && !line.startsWith("new file mode ") && !line.startsWith("deleted file mode ") && !line.startsWith("similarity index ") && !line.startsWith("rename from ") && !line.startsWith("rename to ")) throw new Error("Unsupported patch line");
  }
  return { ops, next: index };
}
export function applyUnifiedFilePatchBytes(source: Uint8Array, rawPatch: string, encoding: PatchEncoding): Buffer {
  if (/^GIT binary patch$/m.test(rawPatch) || /^Binary files /m.test(rawPatch)) throw new Error("Binary patches cannot be published automatically");
  const sourceLines = splitBufferLines(Buffer.from(source));
  const output: Buffer[] = [];
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
    const parsed = parseHunkOps(lines, index + 1);
    for (const op of parsed.ops) {
      const bytes = lineBytes(op, encoding);
      if (op.marker === " ") {
        if (!sourceLines[cursor]?.equals(bytes)) throw new Error("Patch context does not match approved source bytes");
        output.push(bytes); cursor += 1;
      } else if (op.marker === "-") {
        if (!sourceLines[cursor]?.equals(bytes)) throw new Error("Patch removal does not match approved source bytes");
        cursor += 1;
      } else output.push(bytes);
    }
    index = parsed.next - 1;
  }
  output.push(...sourceLines.slice(cursor));
  return Buffer.concat(output);
}

type TreeEntry = { readonly path: string; readonly mode: string; readonly type: string; readonly sha: string };
function verifiedMap(files: readonly VerifiedFile[]): Map<string, VerifiedFile> {
  const map = new Map<string, VerifiedFile>();
  for (const file of files) {
    if (map.has(file.path)) mismatch(`Verified file evidence contains duplicate path ${file.path}.`);
    if (file.deleted) {
      if (file.blobSha !== null || file.mode !== null) mismatch(`Deleted verified path ${file.path} must not have blob or mode.`);
    } else if (!file.blobSha || !/^[0-9a-f]{40}$/i.test(file.blobSha) || (file.mode !== "100644" && file.mode !== "100755")) mismatch(`Verified file evidence is invalid for ${file.path}.`);
    map.set(file.path, file);
  }
  return map;
}

export class GitHubRestPublicationClient implements GitHubPublicationClient {
  private readonly fetchImpl: typeof fetch;
  private readonly apiVersion: string;
  constructor(private readonly options: { readonly appId: string; readonly privateKey: string; readonly fetchImpl?: typeof fetch; readonly apiVersion?: string; readonly nowMs?: () => number; readonly createAppJwt?: () => string }) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.apiVersion = options.apiVersion ?? "2026-03-10";
  }

  async beginPublishOperation(repositoryFullName: string): Promise<GitHubPublicationOperation> {
    const [owner, repo] = repoParts(repositoryFullName);
    const jwt = this.options.createAppJwt?.() ?? appJwt(this.options.appId, this.options.privateKey, (this.options.nowMs ?? Date.now)());
    const commonAppHeaders = { accept: "application/vnd.github+json", authorization: `Bearer ${jwt}`, "x-github-api-version": this.apiVersion };
    const installation = await this.fetchImpl(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`, { headers: commonAppHeaders });
    if (!installation.ok) throw new Error(`GitHub installation lookup failed (${installation.status})`);
    const installationId = numberField((await jsonObject(installation)).id, "installation id");
    const tokenResponse = await this.fetchImpl(`https://api.github.com/app/installations/${installationId}/access_tokens`, { method: "POST", headers: commonAppHeaders });
    if (!tokenResponse.ok) throw new Error(`GitHub installation token request failed (${tokenResponse.status})`);
    const token = stringField((await jsonObject(tokenResponse)).token, "installation token");

    const request = async (path: string, init: RequestInit = {}): Promise<Response> => {
      const headers = new Headers(init.headers);
      headers.set("accept", "application/vnd.github+json");
      headers.set("authorization", `Bearer ${token}`);
      headers.set("x-github-api-version", this.apiVersion);
      if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
      return await this.fetchImpl(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${path}`, { ...init, headers });
    };
    const api = async (path: string, init: RequestInit = {}): Promise<Record<string, unknown>> => {
      const response = await request(path, init);
      if (!response.ok) throw new Error(`GitHub publication request failed (${response.status})`);
      return await jsonObject(response);
    };
    const contentSha = async (path: string, ref: string): Promise<string | null> => {
      const encodedPath = path.split("/").map(encodeURIComponent).join("/");
      const response = await request(`/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`);
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`GitHub protected-file lookup failed (${response.status})`);
      return stringField((await jsonObject(response)).sha, "content sha");
    };

    return {
      async getDefaultBranchHead(defaultBranch) {
        const body = await api(`/git/ref/heads/${encodeURIComponent(defaultBranch)}`);
        const object = body.object as Record<string, unknown> | undefined;
        return { sha: stringField(object?.sha, "ref sha") };
      },
      async compareCommits(input) {
        const body = await api(`/compare/${input.baseSha}...${input.headSha}`);
        const aheadBy = typeof body.ahead_by === "number" && Number.isSafeInteger(body.ahead_by) ? body.ahead_by : 0;
        const reported = new Set<string>();
        if (Array.isArray(body.files)) for (const item of body.files) {
          if (!item || typeof item !== "object") continue;
          const row = item as Record<string, unknown>;
          if (typeof row.filename === "string") reported.add(row.filename);
          if (typeof row.previous_filename === "string") reported.add(row.previous_filename);
        }
        const candidates = input.protectedPaths.filter((path) => reported.has(path));
        const files: string[] = [];
        for (const path of candidates) {
          const [before, after] = await Promise.all([contentSha(path, input.baseSha), contentSha(path, input.headSha)]);
          if (before !== after) files.push(path);
        }
        return { aheadBy, files };
      },
      async ensurePatchedBranch(input) {
        const verified = verifiedMap(input.verifiedFiles);
        const parsedFiles = parsePatchFiles(input.patch);
        const patchPaths = new Set<string>();
        for (const file of parsedFiles) {
          if (file.oldPath && (file.newPath === null || file.oldPath !== file.newPath)) patchPaths.add(file.oldPath);
          if (file.newPath) patchPaths.add(file.newPath);
        }
        if (patchPaths.size !== verified.size || [...patchPaths].some((path) => !verified.has(path)) || [...verified.keys()].some((path) => !patchPaths.has(path))) mismatch("Verified files do not exactly match patch paths; publication refused.");

        const commit = await api(`/git/commits/${input.approvedSha}`);
        const commitTree = commit.tree as Record<string, unknown> | undefined;
        const baseTreeSha = stringField(commitTree?.sha, "commit tree sha");
        const treeBody = await api(`/git/trees/${baseTreeSha}?recursive=1`);
        const baseEntries = new Map<string, TreeEntry>();
        if (Array.isArray(treeBody.tree)) for (const value of treeBody.tree) {
          if (!value || typeof value !== "object") continue;
          const entry = value as Record<string, unknown>;
          if (typeof entry.path === "string" && typeof entry.mode === "string" && typeof entry.type === "string" && typeof entry.sha === "string") baseEntries.set(entry.path, { path: entry.path, mode: entry.mode, type: entry.type, sha: entry.sha });
        }
        const entries: Array<{ path: string; mode: string; type: "blob"; sha: string | null }> = [];
        for (const file of parsedFiles) {
          if (file.oldPath && (file.newPath === null || file.oldPath !== file.newPath)) {
            const deletion = verified.get(file.oldPath);
            if (!deletion?.deleted) mismatch(`Verified deletion is missing for ${file.oldPath}.`);
            entries.push({ path: file.oldPath, mode: baseEntries.get(file.oldPath)?.mode ?? "100644", type: "blob", sha: null });
          }
          if (!file.newPath) continue;
          const expected = verified.get(file.newPath);
          if (!expected || expected.deleted || !expected.blobSha || !expected.mode) mismatch(`Verified content is missing for ${file.newPath}.`);
          let source = Buffer.alloc(0);
          if (file.oldPath) {
            const oldEntry = baseEntries.get(file.oldPath);
            if (!oldEntry || oldEntry.type !== "blob") throw new Error(`Approved source file is unavailable: ${file.oldPath}`);
            const blob = await api(`/git/blobs/${oldEntry.sha}`);
            const content = stringField(blob.content, "blob content").replace(/\n/g, "");
            const encoding = stringField(blob.encoding, "blob encoding");
            if (encoding !== "base64") throw new Error("GitHub blob encoding must be base64");
            source = Buffer.from(content, "base64");
          }
          if (/^GIT binary patch$/m.test(file.raw) || /^Binary files /m.test(file.raw)) throw new Error("Binary patches cannot be published automatically");
          let next: Buffer | null = null;
          for (const encoding of ["utf8", "latin1"] as const) {
            try {
              const candidate = applyUnifiedFilePatchBytes(source, file.raw, encoding);
              if (gitBlobSha(candidate) === expected.blobSha.toLowerCase()) { next = candidate; break; }
            } catch { /* try alternate text encoding before refusing */ }
          }
          if (!next) mismatch(`Published content would differ from verified content for ${file.newPath}.`);
          const blob = await api("/git/blobs", { method: "POST", body: JSON.stringify({ content: next.toString("base64"), encoding: "base64" }) });
          const createdSha = stringField(blob.sha, "blob sha").toLowerCase();
          if (createdSha !== expected.blobSha.toLowerCase()) mismatch(`GitHub blob does not match verified content for ${file.newPath}.`);
          entries.push({ path: file.newPath, mode: expected.mode, type: "blob", sha: createdSha });
        }

        const createdTree = await api("/git/trees", { method: "POST", body: JSON.stringify({ base_tree: baseTreeSha, tree: entries }) });
        const expectedTreeSha = stringField(createdTree.sha, "tree sha");
        const createdCommit = await api("/git/commits", { method: "POST", body: JSON.stringify({ message: `Dhara implementation ${input.branchName.split("-").at(-1) ?? ""}`, tree: expectedTreeSha, parents: [input.approvedSha] }) });
        const desiredCommitSha = stringField(createdCommit.sha, "commit sha");
        const refPath = `/git/ref/heads/${input.branchName.split("/").map(encodeURIComponent).join("/")}`;
        let currentSha: string | null = null;
        const currentResponse = await request(refPath);
        if (currentResponse.status === 404) {
          await api("/git/refs", { method: "POST", body: JSON.stringify({ ref: `refs/heads/${input.branchName}`, sha: input.approvedSha }) });
          currentSha = input.approvedSha;
        } else if (currentResponse.ok) {
          const current = await jsonObject(currentResponse); const object = current.object as Record<string, unknown> | undefined; currentSha = stringField(object?.sha, "branch sha");
        } else throw new Error(`GitHub branch lookup failed (${currentResponse.status})`);
        if (currentSha === desiredCommitSha) return { headSha: desiredCommitSha };
        if (currentSha !== input.approvedSha) {
          const existingCommit = await api(`/git/commits/${currentSha}`);
          const existingTree = existingCommit.tree as Record<string, unknown> | undefined;
          if (existingTree?.sha === expectedTreeSha) return { headSha: currentSha };
          throw new Error("Deterministic publication branch exists with unexpected content; refusing to force-push");
        }
        await api(`/git/refs/heads/${input.branchName.split("/").map(encodeURIComponent).join("/")}`, { method: "PATCH", body: JSON.stringify({ sha: desiredCommitSha, force: false }) });
        return { headSha: desiredCommitSha };
      },
      async findOpenPullRequest(input) {
        const response = await request(`/pulls?state=open&head=${encodeURIComponent(`${owner}:${input.branchName}`)}&base=${encodeURIComponent(input.baseBranch)}&per_page=10`);
        if (!response.ok) throw new Error(`GitHub pull request lookup failed (${response.status})`);
        const body = await response.json() as unknown;
        if (!Array.isArray(body) || body.length === 0) return null;
        const first = body[0] as Record<string, unknown>;
        return { number: numberField(first.number, "pull request number"), url: stringField(first.html_url, "pull request URL") };
      },
      async createPullRequest(input) {
        const body = await api("/pulls", { method: "POST", body: JSON.stringify({ title: input.title, head: input.branchName, base: input.baseBranch, body: input.body }) });
        return { number: numberField(body.number, "pull request number"), url: stringField(body.html_url, "pull request URL") };
      },
    };
  }
}

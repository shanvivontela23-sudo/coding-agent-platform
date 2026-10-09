import { createHash, createSign } from "node:crypto";
import { gzipSync } from "node:zlib";
import { type TenantPool, withTenant } from "../../api/src/database.js";
import type { ProjectStorage } from "../../api/src/project-storage.js";
import type { ProjectReport } from "../../api/src/repository-analysis.js";
import { readNormalizedZipFiles, type UploadArchiveLimits } from "../../api/src/upload-archive.js";
import type { ExecutionSourceProvider, PreparedExecutionSource } from "./execution-source.js";

export type GitHubPinnedArchiveReader = {
  read(input: { readonly installationId: number; readonly repositoryFullName: string; readonly commitSha: string; readonly maxBytes: number }): Promise<{ readonly archive: Uint8Array; readonly sha256: string }>;
};

type SourceRow = {
  status: string;
  confirmed_requirement: string | null;
  confirmed_plan: string | null;
  job_type: string | null;
  report: ProjectReport | null;
  repository_full_name: string | null;
  installation_id: string | number | null;
  version_id: string | null;
  version_storage_key: string | null;
  version_sha256: string | null;
};

function base64urlJson(value: unknown): string { return Buffer.from(JSON.stringify(value)).toString("base64url"); }
function githubJwt(appId: string, privateKey: string, nowSeconds = Math.floor(Date.now() / 1_000)): string {
  const header = base64urlJson({ alg: "RS256", typ: "JWT" });
  const payload = base64urlJson({ iat: nowSeconds - 30, exp: nowSeconds + 9 * 60, iss: appId });
  const unsigned = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned); signer.end();
  return `${unsigned}.${signer.sign(privateKey.replaceAll("\\n", "\n"), "base64url")}`;
}

async function jsonObject(response: Response): Promise<Record<string, unknown>> {
  const value = await response.json() as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("GitHub response was not an object");
  return value as Record<string, unknown>;
}

export class GitHubInstallationArchiveReader implements GitHubPinnedArchiveReader {
  constructor(private readonly options: { readonly appId: string; readonly privateKey: string; readonly fetchImpl?: typeof fetch }) {}

  async read(input: { readonly installationId: number; readonly repositoryFullName: string; readonly commitSha: string; readonly maxBytes: number }): Promise<{ readonly archive: Uint8Array; readonly sha256: string }> {
    if (!/^[0-9a-f]{40}$/.test(input.commitSha)) throw new Error("Pinned GitHub source must use a lowercase 40-character SHA");
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repositoryFullName)) throw new Error("GitHub repository full name is invalid");
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const tokenResponse = await fetchImpl(`https://api.github.com/app/installations/${input.installationId}/access_tokens`, {
      method: "POST",
      headers: { authorization: `Bearer ${githubJwt(this.options.appId, this.options.privateKey)}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
    });
    if (!tokenResponse.ok) throw new Error(`GitHub installation token request failed with status ${tokenResponse.status}`);
    const tokenBody = await jsonObject(tokenResponse);
    if (typeof tokenBody.token !== "string" || !tokenBody.token) throw new Error("GitHub installation token response did not contain a token");

    const [owner, repo] = input.repositoryFullName.split("/");
    const archiveResponse = await fetchImpl(`https://api.github.com/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(repo!)}/tarball/${input.commitSha}`, {
      headers: { authorization: `Bearer ${tokenBody.token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
      redirect: "follow",
    });
    if (!archiveResponse.ok) throw new Error(`GitHub pinned archive request failed with status ${archiveResponse.status}`);
    const declared = Number(archiveResponse.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > input.maxBytes) throw new Error("GitHub pinned archive exceeds configured source limit");
    const archive = new Uint8Array(await archiveResponse.arrayBuffer());
    if (archive.byteLength > input.maxBytes) throw new Error("GitHub pinned archive exceeds configured source limit");
    return { archive, sha256: createHash("sha256").update(archive).digest("hex") };
  }
}

function tarOctal(value: number, width: number): Buffer {
  const text = value.toString(8).padStart(width - 1, "0") + "\0";
  return Buffer.from(text, "ascii");
}
function tarHeader(path: string, size: number): Buffer {
  const full = `source/${path}`;
  let name = full; let prefix = "";
  if (Buffer.byteLength(full) > 100) {
    const slash = full.lastIndexOf("/");
    if (slash <= 0) throw new Error(`ZIP source path is too long for execution archive: ${path}`);
    prefix = full.slice(0, slash); name = full.slice(slash + 1);
    if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155) throw new Error(`ZIP source path is too long for execution archive: ${path}`);
  }
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, 100, "utf8");
  tarOctal(0o600, 8).copy(header, 100);
  tarOctal(0, 8).copy(header, 108); tarOctal(0, 8).copy(header, 116);
  tarOctal(size, 12).copy(header, 124); tarOctal(0, 12).copy(header, 136);
  header.fill(0x20, 148, 156); header[156] = "0".charCodeAt(0);
  header.write("ustar\0", 257, 6, "ascii"); header.write("00", 263, 2, "ascii");
  if (prefix) header.write(prefix, 345, 155, "utf8");
  let checksum = 0; for (const byte of header) checksum += byte;
  const checksumText = checksum.toString(8).padStart(6, "0");
  header.write(checksumText, 148, 6, "ascii"); header[154] = 0; header[155] = 0x20;
  return header;
}
function zipToTarGz(zip: Uint8Array, limits: UploadArchiveLimits): Uint8Array {
  const chunks: Buffer[] = [];
  for (const file of readNormalizedZipFiles(zip, limits)) {
    const bytes = Buffer.from(file.bytes); chunks.push(tarHeader(file.path, bytes.length), bytes);
    const padding = (512 - (bytes.length % 512)) % 512; if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
}

function installCommand(report: ProjectReport): string | null {
  switch (report.packageManager?.toLowerCase()) {
    case "pnpm": return "pnpm install --frozen-lockfile";
    case "npm": return "npm ci";
    case "yarn": return "yarn install --frozen-lockfile";
    case "bun": return "bun install --frozen-lockfile";
    default: return null;
  }
}

export class ProductExecutionSourceProvider implements ExecutionSourceProvider {
  constructor(private readonly options: {
    readonly pool: TenantPool;
    readonly storage: ProjectStorage;
    readonly github: GitHubPinnedArchiveReader;
    readonly zipLimits: UploadArchiveLimits;
    readonly maxGitHubArchiveBytes: number;
  }) {}

  async prepare(input: { readonly organizationId: string; readonly taskId: string; readonly projectId: string; readonly sourceCommitSha: string | null; readonly sourceVersionId: string | null }): Promise<PreparedExecutionSource> {
    const row = await withTenant(this.options.pool, { organizationId: input.organizationId }, async (database) => {
      const result = await database.query<SourceRow>(
        `SELECT t.status,t.confirmed_requirement,t.confirmed_plan,t.job_type,pr.report,
                r.full_name AS repository_full_name,gi.installation_id,
                pv.id AS version_id,pv.storage_key AS version_storage_key,pv.sha256 AS version_sha256
           FROM tasks t
           JOIN project_reports pr ON pr.organization_id=t.organization_id AND pr.project_id=t.project_id
           LEFT JOIN repositories r ON r.organization_id=t.organization_id AND r.project_id=t.project_id AND r.provider='github'
           LEFT JOIN github_installations gi ON gi.organization_id=t.organization_id
           LEFT JOIN project_versions pv ON pv.organization_id=t.organization_id AND pv.project_id=t.project_id AND pv.id=$4
          WHERE t.organization_id=$1 AND t.id=$2 AND t.project_id=$3
          ORDER BY r.created_at NULLS LAST
          LIMIT 1`,
        [input.organizationId, input.taskId, input.projectId, input.sourceVersionId],
      );
      return result.rows[0] ?? null;
    });
    if (!row) throw new Error("Approved task source is not visible to the worker");
    if (row.status !== "approved" || !row.confirmed_requirement || !row.confirmed_plan) throw new Error("Task is not approved with a confirmed requirement and plan");
    if (!row.report || typeof row.report !== "object") throw new Error("Project report is unavailable for execution");

    let repository;
    if (input.sourceCommitSha) {
      const installationId = Number(row.installation_id);
      if (!Number.isSafeInteger(installationId) || installationId <= 0 || !row.repository_full_name) throw new Error("GitHub installation or repository is unavailable for pinned execution");
      const archive = await this.options.github.read({ installationId, repositoryFullName: row.repository_full_name, commitSha: input.sourceCommitSha, maxBytes: this.options.maxGitHubArchiveBytes });
      repository = { pinnedCommit: input.sourceCommitSha, archiveSha256: archive.sha256, archive: archive.archive };
    } else if (input.sourceVersionId) {
      if (row.version_id !== input.sourceVersionId || !row.version_storage_key || !row.version_sha256) throw new Error("Pinned ZIP project version is unavailable");
      const zip = await this.options.storage.readVersion(row.version_storage_key);
      const actualZipSha = createHash("sha256").update(zip).digest("hex");
      if (actualZipSha !== row.version_sha256.toLowerCase()) throw new Error("Pinned ZIP project version digest does not match stored metadata");
      const archive = zipToTarGz(zip, this.options.zipLimits);
      repository = { pinnedCommit: row.version_sha256.toLowerCase().slice(0, 40), archiveSha256: createHash("sha256").update(archive).digest("hex"), archive };
    } else {
      throw new Error("Execution has no pinned source");
    }

    return {
      repository,
      jobType: row.job_type,
      requirement: row.confirmed_requirement,
      plan: row.confirmed_plan,
      commands: { install: installCommand(row.report), test: row.report.testCommand, build: row.report.buildCommand },
      reviewFocus: "Review the generated patch against the approved plan, verification evidence, dependency changes, and any unverified pre-existing failures.",
    };
  }
}

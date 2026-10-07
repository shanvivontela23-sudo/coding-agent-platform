import { createHmac, sign as signBytes, timingSafeEqual } from "node:crypto";
import { analysisManifestPaths, type RepositorySnapshot, type RepositoryTreeEntry } from "../../../packages/project-analysis/index.js";
import { ApiError } from "./errors.js";

const githubApiVersion = "2026-03-10";
const githubApiOrigin = "https://api.github.com";
const githubWebOrigin = "https://github.com";
const statePurpose = "github_install";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const commitShaPattern = /^[0-9a-f]{40}$/i;
const maxManifestBytes = 1024 * 1024;
const maxManifestFiles = 128;

type InstallStatePayload = {
  readonly purpose: typeof statePurpose;
  readonly stateId: string;
  readonly expiresAtMs: number;
};

export type InstallStateIdentity = {
  readonly stateId: string;
  readonly expiresAtMs: number;
};

export type RepositorySummary = {
  readonly id: number;
  readonly name: string;
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly private: boolean;
};

export type GitHubRepositorySource = {
  readonly repository: RepositorySummary;
  readonly commitSha: string;
  readonly snapshot: RepositorySnapshot;
};

export type GitHubAppClient = {
  installationUrl(state: string): string;
  exchangeUserCode(code: string): Promise<string>;
  listUserInstallations(userToken: string): Promise<readonly number[]>;
  mintInstallationToken(installationId: number): Promise<string>;
  listInstallationRepositories(installationToken: string): Promise<readonly RepositorySummary[]>;
  loadRepositorySnapshot(installationToken: string, repositoryId: number): Promise<GitHubRepositorySource>;
};

export type GitHubAppClientOptions = {
  readonly appSlug: string;
  readonly appId: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly privateKey: string;
  readonly fetchImpl?: typeof fetch;
  readonly nowMs?: () => number;
};

type GitHubTreeEntry = {
  readonly path?: unknown;
  readonly type?: unknown;
  readonly sha?: unknown;
  readonly size?: unknown;
};

type GitHubTreeResponse = {
  readonly tree?: unknown;
  readonly truncated?: unknown;
};

function encoded(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function stateSignature(payload: string, secret: string): string {
  if (secret.length < 32) throw new Error("GitHub state secret must be at least 32 characters");
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function createInstallStateToken(identity: InstallStateIdentity, secret: string): string {
  if (!uuidPattern.test(identity.stateId) || !Number.isFinite(identity.expiresAtMs)) throw new ApiError("github_state_invalid", 400);
  const payload: InstallStatePayload = { purpose: statePurpose, stateId: identity.stateId, expiresAtMs: identity.expiresAtMs };
  const body = encoded(JSON.stringify(payload));
  return `${body}.${stateSignature(body, secret)}`;
}

export function verifyInstallStateToken(token: string, secret: string, nowMs = Date.now()): InstallStateIdentity {
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra !== undefined || !safeEqual(signature, stateSignature(body, secret))) throw new ApiError("github_state_invalid", 400);
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw new ApiError("github_state_invalid", 400);
  }
  if (
    typeof payload !== "object" || payload === null || Array.isArray(payload) ||
    (payload as Partial<InstallStatePayload>).purpose !== statePurpose ||
    typeof (payload as Partial<InstallStatePayload>).stateId !== "string" ||
    !uuidPattern.test((payload as InstallStatePayload).stateId) ||
    typeof (payload as Partial<InstallStatePayload>).expiresAtMs !== "number" ||
    !Number.isFinite((payload as InstallStatePayload).expiresAtMs) ||
    (payload as InstallStatePayload).expiresAtMs <= nowMs
  ) throw new ApiError("github_state_invalid", 400);
  return { stateId: (payload as InstallStatePayload).stateId, expiresAtMs: (payload as InstallStatePayload).expiresAtMs };
}

export function selectVerifiedInstallation(candidateId: number | null, accessibleIds: readonly number[], excludedIds: ReadonlySet<number>): number {
  const accessible = [...new Set(accessibleIds.filter((id) => Number.isSafeInteger(id) && id > 0 && !excludedIds.has(id)))];
  if (candidateId !== null) {
    if (!Number.isSafeInteger(candidateId) || candidateId <= 0 || !accessible.includes(candidateId)) throw new ApiError("github_installation_unverified", 400);
    return candidateId;
  }
  if (accessible.length !== 1) throw new ApiError("github_installation_unverified", 400);
  return accessible[0]!;
}

function appJwt(appId: string, privateKey: string, nowMs: number): string {
  const nowSeconds = Math.floor(nowMs / 1000);
  const header = encoded(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = encoded(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: appId }));
  const signingInput = `${header}.${claims}`;
  const signature = signBytes("RSA-SHA256", Buffer.from(signingInput), privateKey).toString("base64url");
  return `${signingInput}.${signature}`;
}

function githubHeaders(token?: string): Headers {
  const headers = new Headers({
    accept: "application/vnd.github+json",
    "x-github-api-version": githubApiVersion,
    "user-agent": "Dhara",
  });
  if (token) headers.set("authorization", `Bearer ${token}`);
  return headers;
}

async function githubJson<T>(fetchImpl: typeof fetch, url: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch {
    throw new ApiError("github_provider_failed", 502);
  }
  if (!response.ok) throw new ApiError("github_provider_failed", 502);
  try {
    return await response.json() as T;
  } catch {
    throw new ApiError("github_provider_failed", 502);
  }
}

function repositoryFromApi(value: unknown): RepositorySummary | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.id !== "number" || !Number.isSafeInteger(row.id) || row.id <= 0 ||
    typeof row.name !== "string" || !row.name ||
    typeof row.full_name !== "string" || !row.full_name ||
    typeof row.default_branch !== "string" || !row.default_branch ||
    typeof row.private !== "boolean"
  ) return null;
  return { id: row.id, name: row.name, fullName: row.full_name, defaultBranch: row.default_branch, private: row.private };
}

function repositoryPath(fullName: string): string {
  const parts = fullName.split("/");
  if (parts.length !== 2 || parts.some((part) => !part)) throw new ApiError("github_provider_failed", 502);
  return parts.map(encodeURIComponent).join("/");
}

export function createGitHubAppClient(options: GitHubAppClientOptions): GitHubAppClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const nowMs = options.nowMs ?? Date.now;

  const listRepositories = async (installationToken: string): Promise<readonly RepositorySummary[]> => {
    const response = await githubJson<{ repositories?: unknown }>(fetchImpl, `${githubApiOrigin}/installation/repositories?per_page=100`, {
      headers: githubHeaders(installationToken),
    });
    if (!Array.isArray(response.repositories)) throw new ApiError("github_provider_failed", 502);
    const repositories = response.repositories.map(repositoryFromApi);
    if (repositories.some((repository) => repository === null)) throw new ApiError("github_provider_failed", 502);
    return (repositories as RepositorySummary[]).sort((a, b) => a.fullName.localeCompare(b.fullName));
  };

  return {
    installationUrl(state) {
      const url = new URL(`/apps/${encodeURIComponent(options.appSlug)}/installations/new`, githubWebOrigin);
      url.searchParams.set("state", state);
      return url.toString();
    },

    async exchangeUserCode(code) {
      const response = await githubJson<{ access_token?: unknown }>(fetchImpl, `${githubWebOrigin}/login/oauth/access_token`, {
        method: "POST",
        headers: new Headers({ accept: "application/json", "content-type": "application/json", "user-agent": "Dhara" }),
        body: JSON.stringify({ client_id: options.clientId, client_secret: options.clientSecret, code }),
      });
      if (typeof response.access_token !== "string" || !response.access_token) throw new ApiError("github_provider_failed", 502);
      return response.access_token;
    },

    async listUserInstallations(userToken) {
      const response = await githubJson<{ installations?: unknown }>(fetchImpl, `${githubApiOrigin}/user/installations?per_page=100`, {
        headers: githubHeaders(userToken),
      });
      if (!Array.isArray(response.installations)) throw new ApiError("github_provider_failed", 502);
      const ids = response.installations.map((value) => typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>).id : undefined);
      if (ids.some((id) => typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0)) throw new ApiError("github_provider_failed", 502);
      return ids as number[];
    },

    async mintInstallationToken(installationId) {
      if (!Number.isSafeInteger(installationId) || installationId <= 0) throw new ApiError("github_installation_unverified", 400);
      const jwt = appJwt(options.appId, options.privateKey, nowMs());
      const response = await githubJson<{ token?: unknown }>(fetchImpl, `${githubApiOrigin}/app/installations/${installationId}/access_tokens`, {
        method: "POST",
        headers: githubHeaders(jwt),
      });
      if (typeof response.token !== "string" || !response.token) throw new ApiError("github_provider_failed", 502);
      return response.token;
    },

    listInstallationRepositories: listRepositories,

    async loadRepositorySnapshot(installationToken, repositoryId) {
      const repositories = await listRepositories(installationToken);
      const repository = repositories.find((candidate) => candidate.id === repositoryId);
      if (!repository) throw new ApiError("not_found", 404);
      const repo = repositoryPath(repository.fullName);
      const ref = await githubJson<{ object?: { sha?: unknown } }>(fetchImpl, `${githubApiOrigin}/repos/${repo}/git/ref/heads/${encodeURIComponent(repository.defaultBranch)}`, {
        headers: githubHeaders(installationToken),
      });
      const commitSha = ref.object?.sha;
      if (typeof commitSha !== "string" || !commitShaPattern.test(commitSha)) throw new ApiError("github_provider_failed", 502);
      const commit = await githubJson<{ tree?: { sha?: unknown } }>(fetchImpl, `${githubApiOrigin}/repos/${repo}/git/commits/${commitSha}`, {
        headers: githubHeaders(installationToken),
      });
      const treeSha = commit.tree?.sha;
      if (typeof treeSha !== "string" || !treeSha) throw new ApiError("github_provider_failed", 502);
      const treeResponse = await githubJson<GitHubTreeResponse>(fetchImpl, `${githubApiOrigin}/repos/${repo}/git/trees/${encodeURIComponent(treeSha)}?recursive=1`, {
        headers: githubHeaders(installationToken),
      });
      if (treeResponse.truncated === true || !Array.isArray(treeResponse.tree)) throw new ApiError("github_provider_failed", 502);

      const blobByPath = new Map<string, { readonly sha: string; readonly size?: number }>();
      const tree: RepositoryTreeEntry[] = [];
      for (const raw of treeResponse.tree as GitHubTreeEntry[]) {
        if (typeof raw.path !== "string" || (raw.type !== "blob" && raw.type !== "tree")) continue;
        if (raw.type === "tree") {
          tree.push({ path: raw.path, type: "tree" });
          continue;
        }
        if (typeof raw.sha !== "string" || !raw.sha) continue;
        if (typeof raw.size === "number" && Number.isFinite(raw.size) && raw.size >= 0) {
          tree.push({ path: raw.path, type: "blob", size: raw.size });
          blobByPath.set(raw.path, { sha: raw.sha, size: raw.size });
        } else {
          tree.push({ path: raw.path, type: "blob" });
          blobByPath.set(raw.path, { sha: raw.sha });
        }
      }

      const files: Record<string, string> = {};
      const manifestPaths = analysisManifestPaths(tree).slice(0, maxManifestFiles);
      for (const path of manifestPaths) {
        const blob = blobByPath.get(path);
        if (!blob || (blob.size !== undefined && blob.size > maxManifestBytes)) continue;
        const response = await githubJson<{ content?: unknown; encoding?: unknown }>(fetchImpl, `${githubApiOrigin}/repos/${repo}/git/blobs/${encodeURIComponent(blob.sha)}`, {
          headers: githubHeaders(installationToken),
        });
        if (response.encoding !== "base64" || typeof response.content !== "string") throw new ApiError("github_provider_failed", 502);
        const decoded = Buffer.from(response.content.replace(/\s/g, ""), "base64");
        if (decoded.byteLength > maxManifestBytes) continue;
        files[path] = decoded.toString("utf8");
      }

      return { repository, commitSha: commitSha.toLowerCase(), snapshot: { tree, files } };
    },
  };
}

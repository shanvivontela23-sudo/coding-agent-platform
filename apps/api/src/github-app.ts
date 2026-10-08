import { createSign } from "node:crypto";
import { AppError } from "./errors.js";
import { analyseRepositoryArchive, type ProjectReport, type RepositoryAnalysisLimits } from "./repository-analysis.js";

export type GitHubRepository = {
  readonly id: number;
  readonly name: string;
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly private: boolean;
};

export type GitHubRepositoryAnalysis = {
  readonly repository: GitHubRepository;
  readonly commitSha: string;
  readonly report: ProjectReport;
};

export type GitHubInstallationDetails = {
  readonly accountLogin: string;
  readonly managementUrl: string;
};

export type GitHubAppClient = {
  installationUrl(state: string): string;
  verifyUserInstallation(code: string, installationId: number): Promise<void>;
  getInstallationDetails(installationId: number): Promise<GitHubInstallationDetails>;
  listRepositories(installationId: number): Promise<readonly GitHubRepository[]>;
  analyseRepository(installationId: number, repositoryId: number, limits: RepositoryAnalysisLimits): Promise<GitHubRepositoryAnalysis>;
  checkInstallation(installationId: number): Promise<void>;
};

export type GitHubAppClientOptions = {
  readonly appId: string;
  readonly appSlug: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly privateKey: string;
  readonly apiVersion?: string;
  readonly fetchImpl?: typeof fetch;
  readonly nowMs?: () => number;
  readonly createAppJwt?: () => string;
};

const githubApi = "https://api.github.com";
const githubWeb = "https://github.com";

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function createJwt(appId: string, privateKey: string, nowMs: number): string {
  const seconds = Math.floor(nowMs / 1000);
  const header = encodeJson({ alg: "RS256", typ: "JWT" });
  const payload = encodeJson({ iat: seconds - 60, exp: seconds + 9 * 60, iss: appId });
  const unsigned = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const key = privateKey.includes("\\n") ? privateKey.replaceAll("\\n", "\n") : privateKey;
  const signature = signer.sign(key).toString("base64url");
  return `${unsigned}.${signature}`;
}

function headers(authorization?: string, apiVersion = "2026-03-10"): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    "x-github-api-version": apiVersion,
    ...(authorization ? { authorization } : {}),
  };
}

async function jsonBody<T>(response: Response, code: "GITHUB_FORBIDDEN" | "GITHUB_INSTALLATION_FORBIDDEN" = "GITHUB_FORBIDDEN"): Promise<T> {
  if (!response.ok) throw new AppError(code, "GitHub authorization failed.", response.status === 401 || response.status === 403 ? 403 : 502);
  return await response.json() as T;
}

function validInstallationId(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new AppError("GITHUB_INSTALLATION_FORBIDDEN", "GitHub installation could not be verified.", 403);
  return value;
}

function validRepositoryId(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new AppError("GITHUB_REPOSITORY_FORBIDDEN", "Repository is not available to this installation.", 403);
  return value;
}

function repositoryFromApi(value: unknown): GitHubRepository | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const repo = value as Record<string, unknown>;
  if (!Number.isSafeInteger(repo.id) || typeof repo.id !== "number" || repo.id <= 0 || typeof repo.name !== "string" || typeof repo.full_name !== "string" || typeof repo.default_branch !== "string" || typeof repo.private !== "boolean") return null;
  return { id: repo.id, name: repo.name, fullName: repo.full_name, defaultBranch: repo.default_branch, private: repo.private };
}

function repoApiPath(fullName: string): string {
  const [owner, repo, extra] = fullName.split("/");
  if (!owner || !repo || extra !== undefined) throw new AppError("GITHUB_REPOSITORY_FORBIDDEN", "Repository metadata is invalid.", 502);
  return `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

async function readCompressed(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.ok || !response.body) throw new AppError("GITHUB_FORBIDDEN", "GitHub repository data could not be read.", 502);
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) throw new AppError("REPOSITORY_TOO_LARGE", "Repository too large to analyse.", 413);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new AppError("REPOSITORY_TOO_LARGE", "Repository too large to analyse.", 413);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

export function createGitHubAppClient(options: GitHubAppClientOptions): GitHubAppClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiVersion = options.apiVersion ?? "2026-03-10";
  const now = options.nowMs ?? Date.now;
  const appJwt = options.createAppJwt ?? (() => createJwt(options.appId, options.privateKey, now()));

  const mintInstallationToken = async (installationId: number): Promise<string> => {
    validInstallationId(installationId);
    const response = await fetchImpl(`${githubApi}/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: headers(`Bearer ${appJwt()}`, apiVersion),
    });
    if ([401, 403, 404, 410].includes(response.status)) throw new AppError("GITHUB_INSTALLATION_DISCONNECTED", "GitHub installation is disconnected.", 409);
    const payload = await jsonBody<{ readonly token?: unknown }>(response);
    if (typeof payload.token !== "string" || payload.token.length < 1) throw new AppError("GITHUB_INSTALLATION_DISCONNECTED", "GitHub installation is disconnected.", 409);
    return payload.token;
  };

  const listWithToken = async (token: string): Promise<readonly GitHubRepository[]> => {
    const repositories: GitHubRepository[] = [];
    for (let page = 1; page <= 100; page += 1) {
      const response = await fetchImpl(`${githubApi}/installation/repositories?per_page=100&page=${page}`, { headers: headers(`Bearer ${token}`, apiVersion) });
      if ([401, 403, 404, 410].includes(response.status)) throw new AppError("GITHUB_INSTALLATION_DISCONNECTED", "GitHub installation is disconnected.", 409);
      const payload = await jsonBody<{ readonly repositories?: unknown }>(response);
      if (!Array.isArray(payload.repositories)) throw new AppError("GITHUB_FORBIDDEN", "GitHub repository list is invalid.", 502);
      const pageRepos = payload.repositories.map(repositoryFromApi).filter((repo): repo is GitHubRepository => repo !== null);
      repositories.push(...pageRepos);
      if (payload.repositories.length < 100) return repositories;
    }
    throw new AppError("GITHUB_FORBIDDEN", "GitHub repository list exceeded the supported page limit.", 502);
  };

  return {
    installationUrl(state) {
      const url = new URL(`/apps/${encodeURIComponent(options.appSlug)}/installations/new`, githubWeb);
      url.searchParams.set("state", state);
      return url.toString();
    },

    async verifyUserInstallation(code, installationId) {
      validInstallationId(installationId);
      if (!code) throw new AppError("GITHUB_INSTALLATION_FORBIDDEN", "GitHub installation could not be verified.", 403);
      const tokenResponse = await fetchImpl(`${githubWeb}/login/oauth/access_token`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: options.clientId, client_secret: options.clientSecret, code }).toString(),
      });
      const tokenPayload = await jsonBody<{ readonly access_token?: unknown }>(tokenResponse, "GITHUB_INSTALLATION_FORBIDDEN");
      if (typeof tokenPayload.access_token !== "string" || !tokenPayload.access_token) throw new AppError("GITHUB_INSTALLATION_FORBIDDEN", "GitHub installation could not be verified.", 403);
      const userToken = tokenPayload.access_token;
      try {
        for (let page = 1; page <= 100; page += 1) {
          const response = await fetchImpl(`${githubApi}/user/installations?per_page=100&page=${page}`, { headers: headers(`Bearer ${userToken}`, apiVersion) });
          const payload = await jsonBody<{ readonly installations?: unknown }>(response, "GITHUB_INSTALLATION_FORBIDDEN");
          if (!Array.isArray(payload.installations)) throw new AppError("GITHUB_INSTALLATION_FORBIDDEN", "GitHub installation could not be verified.", 403);
          if (payload.installations.some((item) => typeof item === "object" && item !== null && (item as { readonly id?: unknown }).id === installationId)) return;
          if (payload.installations.length < 100) break;
        }
      } finally {
        // userToken intentionally falls out of scope here and is never persisted or returned.
      }
      throw new AppError("GITHUB_INSTALLATION_FORBIDDEN", "GitHub installation could not be verified.", 403);
    },

    async getInstallationDetails(installationId) {
      validInstallationId(installationId);
      const response = await fetchImpl(`${githubApi}/app/installations/${installationId}`, { headers: headers(`Bearer ${appJwt()}`, apiVersion) });
      if ([401, 403, 404, 410].includes(response.status)) throw new AppError("GITHUB_INSTALLATION_DISCONNECTED", "GitHub installation is disconnected.", 409);
      const payload = await jsonBody<{ readonly account?: unknown; readonly html_url?: unknown }>(response);
      const account = typeof payload.account === "object" && payload.account !== null && !Array.isArray(payload.account) ? payload.account as Record<string, unknown> : null;
      if (!account || typeof account.login !== "string" || !account.login || typeof payload.html_url !== "string") throw new AppError("GITHUB_FORBIDDEN", "GitHub installation metadata is invalid.", 502);
      const managementUrl = new URL(payload.html_url);
      if (managementUrl.protocol !== "https:" || managementUrl.hostname !== "github.com") throw new AppError("GITHUB_FORBIDDEN", "GitHub installation metadata is invalid.", 502);
      return { accountLogin: account.login, managementUrl: managementUrl.toString() };
    },

    async listRepositories(installationId) {
      const token = await mintInstallationToken(installationId);
      return await listWithToken(token);
    },

    async checkInstallation(installationId) {
      await mintInstallationToken(installationId);
    },

    async analyseRepository(installationId, repositoryId, limits) {
      validRepositoryId(repositoryId);
      const token = await mintInstallationToken(installationId);
      const repositories = await listWithToken(token);
      const repository = repositories.find((candidate) => candidate.id === repositoryId);
      if (!repository) throw new AppError("GITHUB_REPOSITORY_FORBIDDEN", "Repository is not available to this installation.", 403);
      const repoPath = repoApiPath(repository.fullName);
      const commitResponse = await fetchImpl(`${githubApi}/repos/${repoPath}/commits/${encodeURIComponent(repository.defaultBranch)}`, { headers: headers(`Bearer ${token}`, apiVersion) });
      const commit = await jsonBody<{ readonly sha?: unknown }>(commitResponse);
      if (typeof commit.sha !== "string" || !/^[0-9a-f]{40}$/i.test(commit.sha)) throw new AppError("GITHUB_FORBIDDEN", "GitHub returned an invalid commit.", 502);
      const commitSha = commit.sha.toLowerCase();
      const archiveResponse = await fetchImpl(`${githubApi}/repos/${repoPath}/tarball/${commitSha}`, {
        headers: headers(`Bearer ${token}`, apiVersion),
        redirect: "manual",
      });
      if (![301, 302, 303, 307, 308].includes(archiveResponse.status)) throw new AppError("GITHUB_FORBIDDEN", "GitHub repository data could not be read.", 502);
      const location = archiveResponse.headers.get("location");
      if (!location) throw new AppError("GITHUB_FORBIDDEN", "GitHub repository data could not be read.", 502);
      const downloadUrl = new URL(location);
      if (downloadUrl.protocol !== "https:" || downloadUrl.hostname !== "codeload.github.com") throw new AppError("GITHUB_FORBIDDEN", "GitHub repository download redirect was not trusted.", 502);
      const downloadResponse = await fetchImpl(downloadUrl, { headers: { accept: "application/octet-stream" }, redirect: "error" });
      const compressed = await readCompressed(downloadResponse, limits.maxCompressedBytes);
      try {
        const report = await analyseRepositoryArchive(compressed, limits);
        return { repository, commitSha, report };
      } finally {
        compressed.fill(0);
      }
    },
  };
}

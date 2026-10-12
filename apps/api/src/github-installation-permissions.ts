import { createSign } from "node:crypto";
import { AppError } from "./errors.js";

export type GitHubInstallationPermissions = {
  readonly contents: "none" | "read" | "write";
};

export type GitHubInstallationPermissionReadOptions = {
  readonly bypassCache?: boolean;
};

export interface GitHubInstallationPermissionReader {
  getInstallationPermissions(installationId: number, options?: GitHubInstallationPermissionReadOptions): Promise<GitHubInstallationPermissions>;
}

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
  return `${unsigned}.${signer.sign(key).toString("base64url")}`;
}

export function createGitHubInstallationPermissionReader(options: {
  readonly appId: string;
  readonly privateKey: string;
  readonly apiVersion?: string;
  readonly fetchImpl?: typeof fetch;
  readonly nowMs?: () => number;
  readonly createAppJwt?: () => string;
  readonly cacheTtlMs?: number;
}): GitHubInstallationPermissionReader {
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiVersion = options.apiVersion ?? "2026-03-10";
  const now = options.nowMs ?? Date.now;
  const jwt = options.createAppJwt ?? (() => createJwt(options.appId, options.privateKey, now()));
  const cacheTtlMs = options.cacheTtlMs ?? 5 * 60_000;
  if (!Number.isSafeInteger(cacheTtlMs) || cacheTtlMs <= 0) throw new Error("GitHub permission cache TTL must be a positive integer");
  const cache = new Map<number, { readonly expiresAt: number; readonly value: GitHubInstallationPermissions }>();

  return {
    async getInstallationPermissions(installationId, readOptions = {}) {
      if (!Number.isSafeInteger(installationId) || installationId <= 0) throw new AppError("GITHUB_INSTALLATION_DISCONNECTED", "GitHub installation is disconnected.", 409);
      const nowMs = now();
      const cached = cache.get(installationId);
      if (!readOptions.bypassCache && cached && cached.expiresAt > nowMs) return cached.value;

      const response = await fetchImpl(`https://api.github.com/app/installations/${installationId}`, {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${jwt()}`,
          "x-github-api-version": apiVersion,
        },
      });
      if ([401, 403, 404, 410].includes(response.status)) {
        cache.delete(installationId);
        throw new AppError("GITHUB_INSTALLATION_DISCONNECTED", "GitHub installation is disconnected.", 409);
      }
      if (!response.ok) throw new AppError("GITHUB_FORBIDDEN", "GitHub installation permissions could not be read.", 502);
      const payload = await response.json() as { readonly permissions?: unknown };
      const permissions = typeof payload.permissions === "object" && payload.permissions !== null && !Array.isArray(payload.permissions)
        ? payload.permissions as Record<string, unknown>
        : null;
      const contents = permissions?.contents;
      const value: GitHubInstallationPermissions = { contents: contents === "write" ? "write" : contents === "read" ? "read" : "none" };
      cache.set(installationId, { expiresAt: nowMs + cacheTtlMs, value });
      return value;
    },
  };
}

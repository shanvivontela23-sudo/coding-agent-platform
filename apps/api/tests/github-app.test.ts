import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGitHubAppClient } from "../src/github-app.js";

const apiVersion = "2026-03-10";
const config = {
  appId: "12345",
  appSlug: "dhara-test",
  clientId: "Iv1.test-client",
  clientSecret: "super-secret-client-secret",
  privateKey: "unused-in-tests",
  apiVersion,
  createAppJwt: () => "app-jwt-secret",
} as const;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function tarGz(entries: ReadonlyArray<{ name: string; contents: string }>): Uint8Array {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.contents);
    const header = Buffer.alloc(512);
    Buffer.from(entry.name).copy(header, 0, 0, 100);
    Buffer.from("0000644\0").copy(header, 100);
    Buffer.from("0000000\0").copy(header, 108);
    Buffer.from("0000000\0").copy(header, 116);
    Buffer.from(`${data.length.toString(8).padStart(11, "0")}\0`).copy(header, 124);
    Buffer.from("00000000000\0").copy(header, 136);
    Buffer.from("        ").copy(header, 148);
    Buffer.from("0").copy(header, 156);
    Buffer.from("ustar\0").copy(header, 257);
    Buffer.from("00").copy(header, 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    Buffer.from(`${checksum.toString(8).padStart(6, "0")}\0 `).copy(header, 148);
    blocks.push(header, data);
    const padding = (512 - (data.length % 512)) % 512;
    if (padding) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

const limits = {
  maxCompressedBytes: 512 * 1024,
  maxUncompressedBytes: 2 * 1024 * 1024,
  maxFiles: 1_000,
  maxFileBytes: 256 * 1024,
} as const;

afterEach(() => vi.restoreAllMocks());

describe("GitHub App client", () => {
  it("builds an installation URL carrying only the supplied signed state", () => {
    const client = createGitHubAppClient({ ...config, fetchImpl: vi.fn() as unknown as typeof fetch });
    const url = new URL(client.installationUrl("signed.state"));
    expect(url.origin).toBe("https://github.com");
    expect(url.pathname).toBe("/apps/dhara-test/installations/new");
    expect(url.searchParams.get("state")).toBe("signed.state");
  });

  it("exchanges the callback code and verifies the exact installation through the user-accessible installation list", async () => {
    const requests: Array<{ url: string; authorization: string | null; body: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, authorization: new Headers(init?.headers).get("authorization"), body: String(init?.body ?? "") });
      if (url === "https://github.com/login/oauth/access_token") return json({ access_token: "github-user-secret" });
      if (url === "https://api.github.com/user/installations?per_page=100&page=1") return json({ total_count: 2, installations: [{ id: 7 }, { id: 42 }] });
      throw new Error(`unexpected request ${url}`);
    };
    const client = createGitHubAppClient({ ...config, fetchImpl });
    await expect(client.verifyUserInstallation("callback-code", 42)).resolves.toBeUndefined();
    expect(requests[0]?.body).toContain("callback-code");
    expect(requests[1]?.authorization).toBe("Bearer github-user-secret");
    expect(JSON.stringify(client)).not.toContain("github-user-secret");
  });

  it("rejects a callback installation the user cannot access and never logs the user token", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input) === "https://github.com/login/oauth/access_token") return json({ access_token: "github-user-secret" });
      return json({ total_count: 1, installations: [{ id: 41 }] });
    };
    const client = createGitHubAppClient({ ...config, fetchImpl });
    await expect(client.verifyUserInstallation("callback-code", 42)).rejects.toMatchObject({ code: "GITHUB_INSTALLATION_FORBIDDEN" });
    expect(error).not.toHaveBeenCalled();
  });

  it("mints an installation token only long enough to list repositories and does not return it", async () => {
    const authorizations: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const authorization = new Headers(init?.headers).get("authorization");
      if (authorization) authorizations.push(authorization);
      if (url === "https://api.github.com/app/installations/42/access_tokens") return json({ token: "ghs_installation_secret", expires_at: "2026-10-07T16:00:00Z" });
      if (url === "https://api.github.com/installation/repositories?per_page=100&page=1") return json({ total_count: 1, repositories: [{ id: 101, name: "widget", full_name: "acme/widget", default_branch: "main", private: true }] });
      throw new Error(`unexpected request ${url}`);
    };
    const client = createGitHubAppClient({ ...config, fetchImpl });
    const repositories = await client.listRepositories(42);
    expect(repositories).toEqual([{ id: 101, name: "widget", fullName: "acme/widget", defaultBranch: "main", private: true }]);
    expect(authorizations).toEqual(["Bearer app-jwt-secret", "Bearer ghs_installation_secret"]);
    expect(JSON.stringify(repositories)).not.toContain("ghs_installation_secret");
  });

  it.each([401, 403, 404, 410])("maps installation-token status %s to disconnected", async (status) => {
    const fetchImpl: typeof fetch = async () => json({ message: "gone and must not be surfaced" }, status);
    const client = createGitHubAppClient({ ...config, fetchImpl });
    await expect(client.listRepositories(42)).rejects.toMatchObject({ code: "GITHUB_INSTALLATION_DISCONNECTED" });
  });

  it("revalidates a selected repository against the installation before any commit or archive request", async () => {
    const urls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("/access_tokens")) return json({ token: "ghs_installation_secret" });
      if (url.includes("/installation/repositories")) return json({ total_count: 1, repositories: [{ id: 101, name: "widget", full_name: "acme/widget", default_branch: "main", private: false }] });
      throw new Error(`unexpected request ${url}`);
    };
    const client = createGitHubAppClient({ ...config, fetchImpl });
    await expect(client.analyseRepository(42, 999, limits)).rejects.toMatchObject({ code: "GITHUB_REPOSITORY_FORBIDDEN" });
    expect(urls.some((url) => url.includes("/commits/"))).toBe(false);
    expect(urls.some((url) => url.includes("/tarball/"))).toBe(false);
  });

  it("pins analysis to the default-branch commit and follows the archive redirect without forwarding credentials", async () => {
    const archive = tarGz([
      { name: "acme-widget-abc123/package.json", contents: JSON.stringify({ scripts: { build: "vite build", test: "vitest run" }, devDependencies: { typescript: "5", vite: "7", vitest: "3" }, dependencies: { react: "19" } }) },
      { name: "acme-widget-abc123/pnpm-lock.yaml", contents: "lockfileVersion: '9.0'\n" },
      { name: "acme-widget-abc123/src/index.ts", contents: "export const value = 1;" },
    ]);
    const archiveBody = archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) as ArrayBuffer;
    const calls: Array<{ url: string; authorization: string | null; redirect: RequestRedirect | undefined }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, authorization: new Headers(init?.headers).get("authorization"), redirect: init?.redirect });
      if (url.endsWith("/access_tokens")) return json({ token: "ghs_installation_secret" });
      if (url.includes("/installation/repositories")) return json({ total_count: 1, repositories: [{ id: 101, name: "widget", full_name: "acme/widget", default_branch: "main", private: false }] });
      if (url === "https://api.github.com/repos/acme/widget/commits/main") return json({ sha: "a".repeat(40) });
      if (url === `https://api.github.com/repos/acme/widget/tarball/${"a".repeat(40)}`) return new Response(null, { status: 302, headers: { location: "https://codeload.github.com/acme/widget/legacy.tar.gz/" + "a".repeat(40) } });
      if (url.startsWith("https://codeload.github.com/")) return new Response(archiveBody, { status: 200, headers: { "content-type": "application/x-gzip" } });
      throw new Error(`unexpected request ${url}`);
    };
    const client = createGitHubAppClient({ ...config, fetchImpl });
    const result = await client.analyseRepository(42, 101, limits);
    expect(result.repository).toEqual({ id: 101, name: "widget", fullName: "acme/widget", defaultBranch: "main", private: false });
    expect(result.commitSha).toBe("a".repeat(40));
    expect(result.report.packageManager).toBe("pnpm");
    const codeload = calls.find((call) => call.url.startsWith("https://codeload.github.com/"));
    expect(codeload?.authorization).toBeNull();
    expect(calls.find((call) => call.url.includes("/tarball/"))?.redirect).toBe("manual");
    expect(JSON.stringify(result)).not.toContain("ghs_installation_secret");
    expect(JSON.stringify(result)).not.toContain("export const value");
  });

  it("enforces the compressed-byte cap while reading the downloaded archive", async () => {
    const large = new Uint8Array(128).fill(1);
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/access_tokens")) return json({ token: "ghs_installation_secret" });
      if (url.includes("/installation/repositories")) return json({ total_count: 1, repositories: [{ id: 101, name: "widget", full_name: "acme/widget", default_branch: "main", private: false }] });
      if (url.includes("/commits/")) return json({ sha: "b".repeat(40) });
      if (url.includes("/tarball/")) return new Response(null, { status: 302, headers: { location: "https://codeload.github.com/acme/widget/archive" } });
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(large.subarray(0, 64)); controller.enqueue(large.subarray(64)); controller.close(); } }));
    };
    const client = createGitHubAppClient({ ...config, fetchImpl });
    await expect(client.analyseRepository(42, 101, { ...limits, maxCompressedBytes: 100 })).rejects.toMatchObject({ code: "REPOSITORY_TOO_LARGE" });
  });
});
import { gzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { analyseRepositoryArchive, RepositoryAnalysisError } from "../src/repository-analysis.js";

type TarEntry = { readonly name: string; readonly contents?: Uint8Array | string; readonly type?: "file" | "symlink" | "hardlink" | "char" | "block"; readonly linkName?: string };

function octal(value: number, width: number): Buffer {
  const text = value.toString(8).padStart(width - 1, "0") + "\0";
  return Buffer.from(text, "ascii");
}

function tar(entries: readonly TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const data = typeof entry.contents === "string" ? Buffer.from(entry.contents) : Buffer.from(entry.contents ?? new Uint8Array());
    const header = Buffer.alloc(512);
    Buffer.from(entry.name).copy(header, 0, 0, 100);
    octal(0o644, 8).copy(header, 100);
    octal(0, 8).copy(header, 108);
    octal(0, 8).copy(header, 116);
    octal(entry.type === "file" || !entry.type ? data.length : 0, 12).copy(header, 124);
    octal(0, 12).copy(header, 136);
    Buffer.from("        ").copy(header, 148);
    const typeFlag = entry.type === "symlink" ? "2" : entry.type === "hardlink" ? "1" : entry.type === "char" ? "3" : entry.type === "block" ? "4" : "0";
    Buffer.from(typeFlag).copy(header, 156);
    if (entry.linkName) Buffer.from(entry.linkName).copy(header, 157, 0, 100);
    Buffer.from("ustar\0").copy(header, 257);
    Buffer.from("00").copy(header, 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    const checksumText = checksum.toString(8).padStart(6, "0");
    Buffer.from(`${checksumText}\0 `, "ascii").copy(header, 148);
    parts.push(header);
    if (data.length && (entry.type === "file" || !entry.type)) {
      parts.push(data);
      const padding = (512 - (data.length % 512)) % 512;
      if (padding) parts.push(Buffer.alloc(padding));
    }
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

function archive(entries: readonly TarEntry[]): Uint8Array {
  return gzipSync(tar(entries));
}

const generousLimits = {
  maxCompressedBytes: 2 * 1024 * 1024,
  maxUncompressedBytes: 4 * 1024 * 1024,
  maxFiles: 1_000,
  maxFileBytes: 512 * 1024,
} as const;

describe("deterministic repository archive analysis", () => {
  it("derives language share, frameworks, package manager, commands and eval-compatible stack skill", async () => {
    const bytes = archive([
      { name: "octo-repo-a1b2/package.json", contents: JSON.stringify({ scripts: { build: "vite build", test: "vitest run" }, dependencies: { react: "19.0.0", vite: "7.0.0" }, devDependencies: { vitest: "3.0.0", typescript: "5.0.0" } }) },
      { name: "octo-repo-a1b2/pnpm-lock.yaml", contents: "lockfileVersion: '9.0'\n" },
      { name: "octo-repo-a1b2/src/a.ts", contents: "export const a = 1;" },
      { name: "octo-repo-a1b2/src/b.tsx", contents: "export const B = () => null;" },
      { name: "octo-repo-a1b2/scripts/c.js", contents: "module.exports = 1;" },
    ]);
    const report = await analyseRepositoryArchive(bytes, generousLimits);
    expect(report.languages).toEqual([
      { name: "TypeScript", fileCount: 2, percentage: 66.67 },
      { name: "JavaScript", fileCount: 1, percentage: 33.33 },
    ]);
    expect(report.frameworks).toEqual(["React", "Vite"]);
    expect(report.packageManager).toBe("pnpm");
    expect(report.buildCommand).toBe("pnpm build");
    expect(report.testCommand).toBe("pnpm test");
    expect(report.stackSkill).toBe("typescript-node");
    expect(report.manifests).toEqual(["package.json", "pnpm-lock.yaml"]);
    expect(JSON.stringify(report)).not.toContain("export const a");
    expect(JSON.stringify(report)).not.toContain("src/a.ts");
  });

  it("falls back to the generic stack skill when no supported stack is detected", async () => {
    const report = await analyseRepositoryArchive(archive([{ name: "repo/readme.txt", contents: "hello" }]), generousLimits);
    expect(report.stackSkill).toBe("generic");
  });

  it("skips path traversal and absolute-path entries instead of exposing them", async () => {
    const report = await analyseRepositoryArchive(archive([
      { name: "repo/../../package.json", contents: JSON.stringify({ scripts: { build: "evil" } }) },
      { name: "/absolute/package.json", contents: JSON.stringify({ scripts: { test: "evil" } }) },
      { name: "repo/package.json", contents: JSON.stringify({ scripts: { build: "safe-build" }, devDependencies: { typescript: "5" } }) },
    ]), generousLimits);
    expect(report.buildCommand).toBe("npm run build");
    expect(report.testCommand).toBeNull();
    expect(report.manifests).toEqual(["package.json"]);
  });

  it("skips symlinks, hard links and device entries", async () => {
    const report = await analyseRepositoryArchive(archive([
      { name: "repo/package.json", contents: JSON.stringify({ devDependencies: { typescript: "5" } }) },
      { name: "repo/link-package.json", type: "symlink", linkName: "package.json" },
      { name: "repo/hard-package.json", type: "hardlink", linkName: "package.json" },
      { name: "repo/device", type: "char" },
    ]), generousLimits);
    expect(report.stackSkill).toBe("typescript-node");
    expect(report.manifests).toEqual(["package.json"]);
  });

  it("returns a clear typed result when compressed input exceeds its cap", async () => {
    const bytes = archive([{ name: "repo/package.json", contents: "{}" }]);
    await expect(analyseRepositoryArchive(bytes, { ...generousLimits, maxCompressedBytes: 8 })).rejects.toMatchObject({
      code: "REPOSITORY_TOO_LARGE",
      publicMessage: "Repository too large to analyse.",
    } satisfies Partial<RepositoryAnalysisError>);
  });

  it("stops a decompression bomb as soon as uncompressed bytes cross the cap", async () => {
    const bomb = archive([{ name: "repo/huge.txt", contents: Buffer.alloc(1024 * 1024, 65) }]);
    expect(bomb.byteLength).toBeLessThan(10_000);
    await expect(analyseRepositoryArchive(bomb, { ...generousLimits, maxUncompressedBytes: 64 * 1024, maxFileBytes: 2 * 1024 * 1024 })).rejects.toMatchObject({ code: "REPOSITORY_TOO_LARGE" });
  });

  it("enforces per-file and file-count caps", async () => {
    await expect(analyseRepositoryArchive(archive([{ name: "repo/big.ts", contents: Buffer.alloc(32, 1) }]), { ...generousLimits, maxFileBytes: 16 })).rejects.toMatchObject({ code: "REPOSITORY_TOO_LARGE" });
    await expect(analyseRepositoryArchive(archive([{ name: "repo/a.ts", contents: "a" }, { name: "repo/b.ts", contents: "b" }]), { ...generousLimits, maxFiles: 1 })).rejects.toMatchObject({ code: "REPOSITORY_TOO_LARGE" });
  });

  it("has no model, gateway, sandbox execution, child-process, or disk-extraction dependency", async () => {
    const source = await readFile("apps/api/src/repository-analysis.ts", "utf8");
    expect(source).not.toMatch(/gateway|model[_-]?call|child_process|exec\(|spawn\(|writeFile|mkdtemp|extract/i);
  });
});
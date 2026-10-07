import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { analyseRepositoryArchive, RepositoryTooLargeError } from "../src/project-report.js";

function tarEntry(name: string, body: Buffer, type = "0", linkName = ""): Buffer {
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, Math.min(100, Buffer.byteLength(name)), "utf8");
  header.write("0000644\0", 100, "ascii"); header.write("0000000\0", 108, "ascii"); header.write("0000000\0", 116, "ascii");
  header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, "ascii"); header.write("00000000000\0", 136, "ascii");
  header.fill(0x20, 148, 156); header.write(type, 156, "ascii"); if (linkName) header.write(linkName, 157, Math.min(100, Buffer.byteLength(linkName)), "utf8");
  header.write("ustar\0", 257, "ascii"); header.write("00", 263, "ascii");
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0); header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return Buffer.concat([header, body, Buffer.alloc((512 - (body.length % 512)) % 512, 0)]);
}
function archive(entries: readonly Buffer[]): Buffer { return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024, 0)])); }
function chunks(value: Buffer, size = 37): AsyncIterable<Uint8Array> { return (async function* () { for (let offset = 0; offset < value.length; offset += size) yield value.subarray(offset, offset + size); })(); }

describe("deterministic project report", () => {
  it("detects TypeScript/Next.js, pnpm and manifest-backed commands", async () => {
    const pkg = Buffer.from(JSON.stringify({ scripts: { build: "next build", test: "vitest run" }, dependencies: { next: "16.4.0", react: "19.0.0" }, devDependencies: { typescript: "5.9.3", vitest: "3.2.7" } }));
    const report = await analyseRepositoryArchive(chunks(archive([tarEntry("repo/package.json", pkg), tarEntry("repo/pnpm-lock.yaml", Buffer.from("lockfileVersion: '9.0'\n")), tarEntry("repo/src/page.tsx", Buffer.from("x")), tarEntry("repo/src/util.ts", Buffer.from("x"))])));
    expect(report.packageManager).toBe("pnpm"); expect(report.frameworks).toContain("Next.js"); expect(report.buildCommands).toContain("pnpm build"); expect(report.testCommands).toContain("pnpm test"); expect(report.stackSkill).toBe("typescript-node"); expect(report.languages[0]).toMatchObject({ language: "TypeScript", files: 2 });
  });
  it("rejects a path traversal entry", async () => { await expect(analyseRepositoryArchive(chunks(archive([tarEntry("../secret.txt", Buffer.from("nope"))])))).rejects.toMatchObject({ code: "REPOSITORY_ARCHIVE_UNSAFE" }); });
  it("skips a symlink entry", async () => { const report = await analyseRepositoryArchive(chunks(archive([tarEntry("repo/link", Buffer.alloc(0), "2", "/etc/passwd"), tarEntry("repo/package.json", Buffer.from("{}"))]))); expect(report.manifests).toEqual(["package.json"]); });
  it("rejects oversized compressed input", async () => { const input = archive([tarEntry("repo/blob.bin", Buffer.alloc(4096, 1))]); await expect(analyseRepositoryArchive(chunks(input), { compressedBytes: 8, uncompressedBytes: 1024 * 1024, fileCount: 100, perFileBytes: 1024 * 1024 })).rejects.toBeInstanceOf(RepositoryTooLargeError); });
  it("stops a decompression bomb at the uncompressed cap", async () => { const input = archive([tarEntry("repo/huge.txt", Buffer.alloc(2 * 1024 * 1024, 65))]); expect(input.byteLength).toBeLessThan(20_000); await expect(analyseRepositoryArchive(chunks(input), { compressedBytes: 50_000, uncompressedBytes: 64 * 1024, fileCount: 100, perFileBytes: 3 * 1024 * 1024 })).rejects.toBeInstanceOf(RepositoryTooLargeError); });
  it("has no model or gateway dependency", async () => { const { readFile } = await import("node:fs/promises"); const source = await readFile("apps/api/src/project-report.ts", "utf8"); expect(source).not.toMatch(/litellm|openai|anthropic|model-gateway/i); });
});

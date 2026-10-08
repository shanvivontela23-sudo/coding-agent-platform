import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { analyseRepositoryArchive } from "../src/repository-analysis.js";
import { validateAndNormalizeZip } from "../src/upload-archive.js";

type ZipEntry = { readonly name: string; readonly contents?: Uint8Array | string; readonly unixMode?: number };
type TarEntry = { readonly name: string; readonly contents?: Uint8Array | string; readonly type?: "file" | "pax" };

function crc32(input: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(entries: readonly ZipEntry[]): Uint8Array {
  const locals: Buffer[] = []; const central: Buffer[] = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name); const data = typeof entry.contents === "string" ? Buffer.from(entry.contents) : Buffer.from(entry.contents ?? new Uint8Array()); const crc = crc32(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(0, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE((3 << 8) | 20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0, 8); directory.writeUInt16LE(0, 10); directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(data.length, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(((entry.unixMode ?? 0o100644) << 16) >>> 0, 38); directory.writeUInt32LE(offset, 42); central.push(directory, name);
    offset += local.length + name.length + data.length;
  }
  const centralBytes = Buffer.concat(central); const localBytes = Buffer.concat(locals); const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(centralBytes.length, 12); eocd.writeUInt32LE(localBytes.length, 16); return Buffer.concat([localBytes, centralBytes, eocd]);
}
function octal(value: number, width: number): Buffer { return Buffer.from(`${value.toString(8).padStart(width - 1, "0")}\0`, "ascii"); }
function tar(entries: readonly TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const data = typeof entry.contents === "string" ? Buffer.from(entry.contents) : Buffer.from(entry.contents ?? new Uint8Array());
    const header = Buffer.alloc(512); Buffer.from(entry.name).copy(header, 0, 0, 100); octal(0o644, 8).copy(header, 100); octal(0, 8).copy(header, 108); octal(0, 8).copy(header, 116); octal(data.length, 12).copy(header, 124); octal(0, 12).copy(header, 136); Buffer.from("        ").copy(header, 148); Buffer.from(entry.type === "pax" ? "x" : "0").copy(header, 156); Buffer.from("ustar\0").copy(header, 257); Buffer.from("00").copy(header, 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0); Buffer.from(`${checksum.toString(8).padStart(6, "0")}\0 `, "ascii").copy(header, 148); parts.push(header, data); const padding = (512 - (data.length % 512)) % 512; if (padding) parts.push(Buffer.alloc(padding));
  }
  parts.push(Buffer.alloc(1024)); return Buffer.concat(parts);
}
function paxRecord(key: string, value: string): string {
  const body = `${key}=${value}\n`; let length = Buffer.byteLength(body) + 3;
  while (true) { const record = `${length} ${body}`; const actual = Buffer.byteLength(record); if (actual === length) return record; length = actual; }
}
function githubArchive(entries: readonly { readonly path: string; readonly contents: string }[]): Uint8Array {
  const tarEntries: TarEntry[] = [];
  entries.forEach((entry, index) => {
    const rooted = `repo/${entry.path}`;
    if (Buffer.byteLength(rooted) > 100) {
      tarEntries.push({ name: `repo/PaxHeaders/${index}`, type: "pax", contents: paxRecord("path", rooted) });
      tarEntries.push({ name: `repo/placeholder-${index}`, contents: entry.contents });
    } else tarEntries.push({ name: rooted, contents: entry.contents });
  });
  return gzipSync(tar(tarEntries));
}
const limits = { maxCompressedBytes: 2 * 1024 * 1024, maxUncompressedBytes: 4 * 1024 * 1024, maxFiles: 100, maxFileBytes: 512 * 1024, maxNestedArchiveDepth: 1 } as const;

describe("Product 07 ZIP validation and normalization", () => {
  it("strips one common root, produces a deterministic report, and stores a normalized ZIP rather than raw bytes", async () => {
    const raw = zip([
      { name: "customer-app/package.json", contents: JSON.stringify({ scripts: { build: "vite build", test: "vitest run" }, dependencies: { react: "19" }, devDependencies: { vite: "7", vitest: "3", typescript: "5" } }) },
      { name: "customer-app/src/app.tsx", contents: "export const App = () => null;" },
    ]);
    const result = await validateAndNormalizeZip(raw, limits);
    expect(result.fileCount).toBe(2);
    expect(result.paths).toEqual(["package.json", "src/app.tsx"]);
    expect(result.report.frameworks).toEqual(expect.arrayContaining(["React", "Vite"]));
    expect(result.report.stackSkill).toBe("typescript-node");
    expect(Buffer.from(result.normalizedZip).equals(Buffer.from(raw))).toBe(false);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches GitHub tar analysis for deep Java source paths over 100 bytes", async () => {
    const javaPath = "src/main/java/com/example/customer/orders/processing/integration/adapters/web/controllers/CancelledOrderVisibilityController.java";
    const pom = "<project><dependencies><dependency><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies></project>";
    const source = "package com.example.customer.orders; public class CancelledOrderVisibilityController {}";
    expect(Buffer.byteLength(javaPath)).toBeGreaterThan(100);

    const githubReport = await analyseRepositoryArchive(githubArchive([{ path: "pom.xml", contents: pom }, { path: javaPath, contents: source }]), limits);
    const upload = await validateAndNormalizeZip(zip([{ name: "customer-app/pom.xml", contents: pom }, { name: `customer-app/${javaPath}`, contents: source }]), limits);

    expect(githubReport.languages).toEqual([{ name: "Java", fileCount: 1, percentage: 100 }]);
    expect(githubReport.frameworks).toContain("Spring Boot");
    expect(upload.report).toEqual(githubReport);
  });

  it.each(["../escape.ts", "/absolute.ts", "C:/windows.ts"])("rejects unsafe archive path %s", async (name) => {
    await expect(validateAndNormalizeZip(zip([{ name, contents: "bad" }]), limits)).rejects.toMatchObject({ code: "INVALID_UPLOAD_ARCHIVE" });
  });

  it("rejects symlink/device-style entries instead of silently storing them", async () => {
    await expect(validateAndNormalizeZip(zip([{ name: "repo/link", contents: "target", unixMode: 0o120777 }]), limits)).rejects.toMatchObject({ code: "INVALID_UPLOAD_ARCHIVE" });
    await expect(validateAndNormalizeZip(zip([{ name: "repo/device", contents: "", unixMode: 0o020666 }]), limits)).rejects.toMatchObject({ code: "INVALID_UPLOAD_ARCHIVE" });
  });

  it("enforces compressed, uncompressed, file-count and per-file limits", async () => {
    const raw = zip([{ name: "repo/a.txt", contents: "1234567890" }, { name: "repo/b.txt", contents: "x" }]);
    await expect(validateAndNormalizeZip(raw, { ...limits, maxCompressedBytes: 8 })).rejects.toMatchObject({ code: "UPLOAD_TOO_LARGE" });
    await expect(validateAndNormalizeZip(raw, { ...limits, maxUncompressedBytes: 5 })).rejects.toMatchObject({ code: "UPLOAD_TOO_LARGE" });
    await expect(validateAndNormalizeZip(raw, { ...limits, maxFiles: 1 })).rejects.toMatchObject({ code: "UPLOAD_TOO_LARGE" });
    await expect(validateAndNormalizeZip(raw, { ...limits, maxFileBytes: 5 })).rejects.toMatchObject({ code: "UPLOAD_TOO_LARGE" });
  });

  it("rejects an archive nested deeper than one level", async () => {
    const second = zip([{ name: "inner.txt", contents: "ok" }]);
    const first = zip([{ name: "nested.zip", contents: second }]);
    const outer = zip([{ name: "repo/first.zip", contents: first }]);
    await expect(validateAndNormalizeZip(outer, limits)).rejects.toMatchObject({ code: "INVALID_UPLOAD_ARCHIVE" });
  });
});

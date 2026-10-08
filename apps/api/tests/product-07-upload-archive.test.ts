import { describe, expect, it } from "vitest";
import { validateAndNormalizeZip } from "../src/upload-archive.js";

type ZipEntry = { readonly name: string; readonly contents?: Uint8Array | string; readonly unixMode?: number };

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

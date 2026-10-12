import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ProjectStorage } from "../src/project-storage.js";
import { buildVerifiedZipResult } from "../src/task-zip-result.js";
import { readStoredNormalizedZipFiles, validateAndNormalizeZip } from "../src/upload-archive.js";
import { createZipResultBuilder } from "../../worker/src/zip-result-builder.js";

const limits = { maxCompressedBytes: 1024 * 1024, maxUncompressedBytes: 2 * 1024 * 1024, maxFiles: 100, maxFileBytes: 256 * 1024, maxNestedArchiveDepth: 1 } as const;
function crc32(input: Uint8Array): number { let crc = 0xffffffff; for (const byte of input) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return (crc ^ 0xffffffff) >>> 0; }
function zip(entries: readonly { readonly name: string; readonly contents: string }[]): Uint8Array {
  const locals: Buffer[] = []; const central: Buffer[] = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name); const data = Buffer.from(entry.contents); const crc = crc32(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26); locals.push(local, name, data);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE((3 << 8) | 20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(data.length, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE((0o100644 << 16) >>> 0, 38); directory.writeUInt32LE(offset, 42); central.push(directory, name); offset += local.length + name.length + data.length;
  }
  const localBytes = Buffer.concat(locals); const centralBytes = Buffer.concat(central); const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(centralBytes.length, 12); eocd.writeUInt32LE(localBytes.length, 16); return Buffer.concat([localBytes, centralBytes, eocd]);
}
function gitBlobSha(bytes: Uint8Array): string { return createHash("sha1").update(Buffer.from(`blob ${bytes.byteLength}\0`)).update(bytes).digest("hex"); }
function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
const patch = ["diff --git a/src/a.txt b/src/a.txt","--- a/src/a.txt","+++ b/src/a.txt","@@ -1 +1 @@","-old","+new",""].join("\n");

class FakeStorage implements ProjectStorage {
  readonly values = new Map<string, Uint8Array>();
  readonly writeVersion = vi.fn(async (input: { organizationId: string; projectId: string; versionId: string; bytes: Uint8Array }) => { const storageKey = `${input.organizationId}/${input.projectId}/${input.versionId}.zip`; this.values.set(storageKey, input.bytes); return { storageKey }; });
  async readVersion(storageKey: string) { const value = this.values.get(storageKey); if (!value) throw new Error("missing fake object"); return value; }
  async deleteVersion(storageKey: string) { this.values.delete(storageKey); }
  async deleteProject() {}
}

const job = {
  executionId: "50000000-0000-4000-8000-000000000801",
  organizationId: "00000000-0000-4000-8000-000000000801",
  taskId: "40000000-0000-4000-8000-000000000801",
  projectId: "20000000-0000-4000-8000-000000000801",
  sourceVersionId: "60000000-0000-4000-8000-000000000801",
};

describe("B4 ZIP result", () => {
  it("builds from the exact approved normalized ZIP, verifies changed bytes, and adds DHARA_CHANGES.md", async () => {
    const approved = await validateAndNormalizeZip(zip([{ name: "repo/src/a.txt", contents: "old\n" }, { name: "repo/keep.txt", contents: "keep\n" }]), limits);
    const expectedBytes = Buffer.from("new\n");
    const result = await buildVerifiedZipResult({ approvedZip: approved.normalizedZip, patch, verifiedFiles: [{ path: "src/a.txt", blobSha: gitBlobSha(expectedBytes), mode: "100644", deleted: false }], changeDocument: "# Change note\nVerified.", limits });
    const files = readStoredNormalizedZipFiles(result.bytes, limits);
    expect(Buffer.from(files.find((file) => file.path === "src/a.txt")!.bytes).toString()).toBe("new\n");
    expect(Buffer.from(files.find((file) => file.path === "keep.txt")!.bytes).toString()).toBe("keep\n");
    expect(Buffer.from(files.find((file) => file.path === "DHARA_CHANGES.md")!.bytes).toString()).toBe("# Change note\nVerified.\n");
  });

  it("does not strip a normalized common directory a second time", async () => {
    const approved = await validateAndNormalizeZip(zip([{ name: "repo/src/a.txt", contents: "old\n" }, { name: "repo/src/b.txt", contents: "keep\n" }]), limits);
    expect(readStoredNormalizedZipFiles(approved.normalizedZip, limits).map((file) => file.path)).toEqual(["src/a.txt", "src/b.txt"]);
    await expect(buildVerifiedZipResult({ approvedZip: approved.normalizedZip, patch, verifiedFiles: [{ path: "src/a.txt", blobSha: gitBlobSha(Buffer.from("new\n")), mode: "100644", deleted: false }], changeDocument: "note", limits })).resolves.toMatchObject({ fileCount: 3 });
  });

  it("refuses before storage when reconstructed bytes do not match verifiedFiles", async () => {
    const approved = await validateAndNormalizeZip(zip([{ name: "repo/src/a.txt", contents: "old\n" }, { name: "repo/package.json", contents: "{}\n" }]), limits);
    await expect(buildVerifiedZipResult({ approvedZip: approved.normalizedZip, patch, verifiedFiles: [{ path: "src/a.txt", blobSha: "d".repeat(40), mode: "100644", deleted: false }], changeDocument: "note", limits })).rejects.toMatchObject({ code: "PUBLISHED_CONTENT_MISMATCH" });
  });

  it("worker builder reads the exact approved version and persists one result artifact", async () => {
    const storage = new FakeStorage();
    const approved = await validateAndNormalizeZip(zip([{ name: "repo/src/a.txt", contents: "old\n" }, { name: "repo/package.json", contents: "{}\n" }]), limits);
    storage.values.set("approved.zip", approved.normalizedZip);
    const insert = vi.fn(async () => true);
    const build = createZipResultBuilder({ storage, artifacts: { insert }, limits });
    await build({ ...job, sourceStorageKey: "approved.zip", sourceSha256: approved.sha256, resultPatch: patch, changeDocument: "note", resultMetadata: { verifiedFiles: [{ path: "src/a.txt", blobSha: gitBlobSha(Buffer.from("new\n")), mode: "100644", deleted: false }] } });
    expect(storage.writeVersion).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it("worker builder refuses a stored source whose digest no longer matches the approved version", async () => {
    const storage = new FakeStorage();
    storage.values.set("approved.zip", zip([{ name: "src/a.txt", contents: "old\n" }]));
    const insert = vi.fn(async () => true);
    const build = createZipResultBuilder({ storage, artifacts: { insert }, limits });
    await expect(build({ ...job, sourceStorageKey: "approved.zip", sourceSha256: "f".repeat(64), resultPatch: patch, changeDocument: "note", resultMetadata: { verifiedFiles: [] } })).rejects.toThrow("digest");
    expect(storage.writeVersion).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
    expect(sha256(storage.values.get("approved.zip")!)).not.toBe("f".repeat(64));
  });

  it("removes a candidate storage object when the artifact insert loses a race", async () => {
    const storage = new FakeStorage();
    const approved = await validateAndNormalizeZip(zip([{ name: "repo/src/a.txt", contents: "old\n" }, { name: "repo/package.json", contents: "{}\n" }]), limits);
    storage.values.set("approved.zip", approved.normalizedZip);
    const build = createZipResultBuilder({ storage, artifacts: { insert: vi.fn(async () => false) }, limits });
    await build({ ...job, sourceStorageKey: "approved.zip", sourceSha256: approved.sha256, resultPatch: patch, changeDocument: "note", resultMetadata: { verifiedFiles: [{ path: "src/a.txt", blobSha: gitBlobSha(Buffer.from("new\n")), mode: "100644", deleted: false }] } });
    expect(storage.writeVersion).toHaveBeenCalledTimes(1);
    expect([...storage.values.keys()]).toEqual(["approved.zip"]);
  });
});

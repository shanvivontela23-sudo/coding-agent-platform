import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LocalProjectStorage } from "../../api/src/project-storage.js";
import { validateAndNormalizeZip } from "../../api/src/upload-archive.js";
import { createZipResultBuilder } from "../src/zip-result-builder.js";

const limits = {
  maxCompressedBytes: 1024 * 1024,
  maxUncompressedBytes: 2 * 1024 * 1024,
  maxFiles: 100,
  maxFileBytes: 256 * 1024,
  maxNestedArchiveDepth: 1,
} as const;

function crc32(input: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(name: string, contents: string): Uint8Array {
  const filename = Buffer.from(name);
  const data = Buffer.from(contents);
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(filename.length, 26);
  const directory = Buffer.alloc(46);
  directory.writeUInt32LE(0x02014b50, 0);
  directory.writeUInt16LE((3 << 8) | 20, 4);
  directory.writeUInt16LE(20, 6);
  directory.writeUInt32LE(crc, 16);
  directory.writeUInt32LE(data.length, 20);
  directory.writeUInt32LE(data.length, 24);
  directory.writeUInt16LE(filename.length, 28);
  directory.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  directory.writeUInt32LE(0, 42);
  const localBytes = Buffer.concat([local, filename, data]);
  const centralBytes = Buffer.concat([directory, filename]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(localBytes.length, 16);
  return Buffer.concat([localBytes, centralBytes, eocd]);
}

function gitBlobSha(bytes: Uint8Array): string {
  return createHash("sha1").update(Buffer.from(`blob ${bytes.byteLength}\0`)).update(bytes).digest("hex");
}

const job = {
  executionId: "50000000-0000-4000-8000-000000000951",
  organizationId: "00000000-0000-4000-8000-000000000951",
  taskId: "40000000-0000-4000-8000-000000000951",
  projectId: "20000000-0000-4000-8000-000000000951",
  sourceVersionId: "60000000-0000-4000-8000-000000000951",
};

const patch = [
  "diff --git a/src/a.txt b/src/a.txt",
  "--- a/src/a.txt",
  "+++ b/src/a.txt",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "",
].join("\n");

describe("ZIP result storage cleanup", () => {
  it("deletes a real stored candidate when interrupted completion returns lost", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "dhara-zip-result-"));
    try {
      const storage = new LocalProjectStorage({ rootDir });
      const approved = await validateAndNormalizeZip(zip("repo/src/a.txt", "old\n"), limits);
      const source = await storage.writeVersion({
        organizationId: job.organizationId,
        projectId: job.projectId,
        versionId: job.sourceVersionId,
        bytes: approved.normalizedZip,
      });
      const complete = vi.fn(async () => "lost" as const);
      const build = createZipResultBuilder({ storage, artifacts: { complete }, limits });

      await expect(build({
        ...job,
        sourceStorageKey: source.storageKey,
        sourceSha256: approved.sha256,
        resultPatch: patch,
        changeDocument: "note",
        resultMetadata: {
          verifiedFiles: [{ path: "src/a.txt", blobSha: gitBlobSha(Buffer.from("new\n")), mode: "100644", deleted: false }],
        },
      })).rejects.toThrow("ownership was lost");

      expect(complete).toHaveBeenCalledTimes(1);
      expect(await readdir(join(rootDir, job.organizationId, job.projectId))).toEqual([`${job.sourceVersionId}.zip`]);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});

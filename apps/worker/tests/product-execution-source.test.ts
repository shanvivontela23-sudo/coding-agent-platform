import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { TenantPool } from "../../api/src/database.js";
import type { ProjectStorage } from "../../api/src/project-storage.js";
import { ProductExecutionSourceProvider, type GitHubPinnedArchiveReader } from "../src/product-execution-source.js";

function crc32(input: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(nameValue: string, contents: string): Uint8Array {
  const name = Buffer.from(nameValue); const data = Buffer.from(contents); const crc = crc32(data);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
  const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE((3 << 8) | 20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(data.length, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE((0o100644 << 16) >>> 0, 38); directory.writeUInt32LE(0, 42);
  const localBytes = Buffer.concat([local, name, data]); const central = Buffer.concat([directory, name]); const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(central.length, 12); eocd.writeUInt32LE(localBytes.length, 16);
  return Buffer.concat([localBytes, central, eocd]);
}

const organizationId = "00000000-0000-4000-8000-000000000901";
const taskId = "40000000-0000-4000-8000-000000000901";
const projectId = "20000000-0000-4000-8000-000000000901";
const versionId = "50000000-0000-4000-8000-000000000901";
const limits = { maxCompressedBytes: 1024 * 1024, maxUncompressedBytes: 2 * 1024 * 1024, maxFiles: 20, maxFileBytes: 1024 * 1024, maxNestedArchiveDepth: 1 } as const;

function poolFor(versionSha: string): TenantPool {
  const query = vi.fn(async (text: string) => {
    if (text.includes("FROM tasks t")) return { rows: [{
      status: "approved",
      confirmed_requirement: "Fix retry",
      confirmed_plan: "Add regression coverage",
      job_type: "bug_fix",
      report: { languages: [], frameworks: [], packageManager: "pnpm", buildCommand: "pnpm build", testCommand: "pnpm test", stackSkill: "typescript-node", manifests: [] },
      repository_full_name: null,
      installation_id: null,
      version_id: versionId,
      version_storage_key: "project/version.zip",
      version_sha256: versionSha,
    }] };
    return { rows: [] };
  });
  return { query, async connect() { return { query, release() {} }; } } as unknown as TenantPool;
}

function storageFor(bytes: Uint8Array): ProjectStorage {
  return { async readVersion() { return bytes; }, async writeVersion() { throw new Error("not used"); }, async deleteVersion() {} } as unknown as ProjectStorage;
}
const github: GitHubPinnedArchiveReader = { async read() { throw new Error("GitHub should not be used for a ZIP source"); } };

describe("ProductExecutionSourceProvider ZIP source", () => {
  it("loads the exact stored version, checks its digest, and carries approved task/report inputs", async () => {
    const bytes = zip("src/index.ts", "export const retry = true;\n");
    const sha = createHash("sha256").update(bytes).digest("hex");
    const provider = new ProductExecutionSourceProvider({ pool: poolFor(sha), storage: storageFor(bytes), github, zipLimits: limits, maxGitHubArchiveBytes: 1024 });
    const result = await provider.prepare({ organizationId, taskId, projectId, sourceCommitSha: null, sourceVersionId: versionId });
    expect(result.repository.pinnedCommit).toBe(sha.slice(0, 40));
    expect(result.repository.archive[0]).toBe(0x1f);
    expect(result.repository.archive[1]).toBe(0x8b);
    expect(result).toMatchObject({
      jobType: "bug_fix",
      requirement: "Fix retry",
      plan: "Add regression coverage",
      commands: { install: "pnpm install --frozen-lockfile", test: "pnpm test", build: "pnpm build" },
    });
  });

  it("rejects a stored ZIP whose bytes do not match the pinned version digest", async () => {
    const bytes = zip("src/index.ts", "export const retry = true;\n");
    const provider = new ProductExecutionSourceProvider({ pool: poolFor("0".repeat(64)), storage: storageFor(bytes), github, zipLimits: limits, maxGitHubArchiveBytes: 1024 });
    await expect(provider.prepare({ organizationId, taskId, projectId, sourceCommitSha: null, sourceVersionId: versionId })).rejects.toThrow(/digest/i);
  });
});
